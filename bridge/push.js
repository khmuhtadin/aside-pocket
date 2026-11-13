// Web Push: VAPID (RFC 8292) + aes128gcm (RFC 8291 / RFC 8188), node:crypto only.
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { DATA_DIR, loadConfig } from './config.js';

const VAPID_FILE = path.join(DATA_DIR, 'vapid.json');
const SUBS_FILE = path.join(DATA_DIR, 'subscriptions.json');

const b64u = (buf) => Buffer.from(buf).toString('base64url');
const unb64u = (str) => Buffer.from(str, 'base64url');

function readJson(file, empty) {
  return fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')) : empty;
}

function writeSecret(file, data) {
  fs.writeFileSync(file, JSON.stringify(data, null, 2), { mode: 0o600 });
  fs.chmodSync(file, 0o600);
}

// { publicKey, privateKey } as base64url raw P-256 values (65-byte point, 32-byte scalar).
function vapid() {
  if (!fs.existsSync(VAPID_FILE)) {
    const ecdh = crypto.createECDH('prime256v1');
    ecdh.generateKeys();
    writeSecret(VAPID_FILE, {
      publicKey: b64u(ecdh.getPublicKey()),
      privateKey: b64u(ecdh.getPrivateKey()),
    });
  }
  return JSON.parse(fs.readFileSync(VAPID_FILE, 'utf8'));
}

export function publicKey() {
  return vapid().publicKey;
}

export function subscribe(subscription) {
  const { endpoint, keys } = subscription;
  if (new URL(endpoint).protocol !== 'https:') throw new Error('endpoint must be https');
  if (!keys?.p256dh || !keys?.auth) throw new Error('subscription keys missing');
  const subs = readJson(SUBS_FILE, []).filter((s) => s.endpoint !== endpoint);
  subs.push({ endpoint, keys: { p256dh: keys.p256dh, auth: keys.auth } });
  writeSecret(SUBS_FILE, subs);
}

// ES256 JWT for the push service at `audience` (the endpoint origin).
export function vapidJwt(audience) {
  const { publicKey: pub, privateKey: priv } = vapid();
  const point = unb64u(pub);
  const key = crypto.createPrivateKey({
    format: 'jwk',
    key: { kty: 'EC', crv: 'P-256', d: priv, x: b64u(point.subarray(1, 33)), y: b64u(point.subarray(33)) },
  });
  const header = b64u(JSON.stringify({ typ: 'JWT', alg: 'ES256' }));
  const claims = b64u(JSON.stringify({
    aud: audience,
    exp: Math.floor(Date.now() / 1000) + 12 * 3600,
    sub: loadConfig().contact,
  }));
  const signature = crypto.sign('sha256', Buffer.from(`${header}.${claims}`), { key, dsaEncoding: 'ieee-p1363' });
  return `${header}.${claims}.${b64u(signature)}`;
}

// RFC 8291 message encryption. `salt` (16 bytes) and `privateKey` (raw 32-byte
// P-256 scalar of the sender's one-time key) are only passed by tests.
export function encrypt(plaintext, p256dhB64, authB64, { salt = crypto.randomBytes(16), privateKey } = {}) {
  const uaPublic = unb64u(p256dhB64);
  const ecdh = crypto.createECDH('prime256v1');
  if (privateKey) ecdh.setPrivateKey(privateKey);
  else ecdh.generateKeys();
  const asPublic = ecdh.getPublicKey();
  const secret = ecdh.computeSecret(uaPublic);

  const keyInfo = Buffer.concat([Buffer.from('WebPush: info\0'), uaPublic, asPublic]);
  const ikm = Buffer.from(crypto.hkdfSync('sha256', secret, unb64u(authB64), keyInfo, 32));
  const cek = Buffer.from(crypto.hkdfSync('sha256', ikm, salt, 'Content-Encoding: aes128gcm\0', 16));
  const nonce = Buffer.from(crypto.hkdfSync('sha256', ikm, salt, 'Content-Encoding: nonce\0', 12));

  const cipher = crypto.createCipheriv('aes-128-gcm', cek, nonce);
  // 0x02 = padding delimiter of the last (only) record.
  const body = Buffer.concat([cipher.update(plaintext), cipher.update(Buffer.from([2])), cipher.final(), cipher.getAuthTag()]);

  // Header: salt(16) | record size(4) | key id length(1) | key id (sender public key)
  const header = Buffer.alloc(21);
  salt.copy(header);
  header.writeUInt32BE(4096, 16);
  header[20] = asPublic.length;
  return Buffer.concat([header, asPublic, body]);
}

export async function sendPush(payload) {
  const subs = readJson(SUBS_FILE, []);
  const plaintext = Buffer.from(JSON.stringify(payload));
  const gone = [];
  const results = [];

  for (const sub of subs) {
    let status = 0;
    try {
      const res = await fetch(sub.endpoint, {
        method: 'POST',
        headers: {
          Authorization: `vapid t=${vapidJwt(new URL(sub.endpoint).origin)}, k=${publicKey()}`,
          'Content-Encoding': 'aes128gcm',
          'Content-Type': 'application/octet-stream',
          TTL: '86400',
          Urgency: 'high',
        },
        body: encrypt(plaintext, sub.keys.p256dh, sub.keys.auth),
      });
      status = res.status;
    } catch {
      status = 0;
    }
    if (status === 404 || status === 410) gone.push(sub.endpoint);
    results.push({ status });
  }

  if (gone.length) {
    writeSecret(SUBS_FILE, readJson(SUBS_FILE, []).filter((s) => !gone.includes(s.endpoint)));
  }

  // Optional ntfy.sh copy, off unless config.json has "ntfyTopic".
  // Header values must be latin1, so the title is sent RFC 2047 encoded.
  const { ntfyTopic } = loadConfig();
  if (ntfyTopic) {
    const title = `=?UTF-8?B?${Buffer.from(String(payload.title ?? '')).toString('base64')}?=`;
    await fetch(`https://ntfy.sh/${ntfyTopic}`, {
      method: 'POST',
      headers: { Title: title },
      body: String(payload.body ?? ''),
    }).catch(() => {});
  }

  return results;
}
