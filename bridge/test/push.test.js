import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// Never touch the real ~/.aside-pocket: the module reads this at import time.
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aside-pocket-test-'));
process.env.ASIDE_POCKET_DIR = dir;
// complete, so nothing is detected on the machine that runs the tests
fs.writeFileSync(path.join(dir, 'config.json'), JSON.stringify({
  asideCli: '/nonexistent/aside', node: process.execPath, tailscale: '/nonexistent/tailscale',
  allowedLogins: ['owner@example.com'], contact: 'mailto:owner@example.com',
}));
const { publicKey, subscribe, vapidJwt, encrypt, sendPush } = await import('../push.js');

test.after(() => fs.rmSync(dir, { recursive: true }));

const unb64u = (s) => Buffer.from(s, 'base64url');
const hkdf = (ikm, salt, info, len) => Buffer.from(crypto.hkdfSync('sha256', ikm, salt, info, len));

// RFC 8291 section 5 / Appendix A.
const RFC = {
  plaintext: 'When I grow up, I want to be a watermelon',
  asPublic: 'BP4z9KsN6nGRTbVYI_c7VJSPQTBtkgcy27mlmlMoZIIgDll6e3vCYLocInmYWAmS6TlzAC8wEqKK6PBru3jl7A8',
  asPrivate: 'yfWPiYE-n46HLnH0KqZOF1fJJU3MYrct3AELtAQ-oRw',
  uaPublic: 'BCVxsr7N_eNgVRqvHtD0zTZsEc6-VV-JvLexhqUzORcxaOzi6-AYWXvTBHm4bjyPjs7Vd8pZGH6SRpkNtoIAiw4',
  uaPrivate: 'q1dXpw3UpT5VOmu_cf_v6ih07Aems3njxI-JWgLcM94',
  auth: 'BTBZMqHH6r4Tts7J_aSIgg',
  salt: 'DGv6ra1nlYgDCS1FRnbzlw',
  body: 'DGv6ra1nlYgDCS1FRnbzlwAAEABBBP4z9KsN6nGRTbVYI_c7VJSPQTBtkgcy27mlmlMoZIIgDll6e3vCYLocInmYWAmS6TlzAC8wEqKK6PBru3jl7A_yl95bQpu6cVPTpK4Mqgkf1CXztLVBSt2Ks3oZwbuwXPXLWyouBWLVWGNWQexSgSxsj_Qulcy4a-fN',
};

// Acts as the user agent: decrypts an aes128gcm body with its private key.
function decrypt(body, uaPrivate, auth) {
  const salt = body.subarray(0, 16);
  const idLen = body[20];
  const asPublic = body.subarray(21, 21 + idLen);
  const ciphertext = body.subarray(21 + idLen, -16);
  const ecdh = crypto.createECDH('prime256v1');
  ecdh.setPrivateKey(uaPrivate);
  const keyInfo = Buffer.concat([Buffer.from('WebPush: info\0'), ecdh.getPublicKey(), asPublic]);
  const ikm = hkdf(ecdh.computeSecret(asPublic), auth, keyInfo, 32);
  const decipher = crypto.createDecipheriv('aes-128-gcm',
    hkdf(ikm, salt, 'Content-Encoding: aes128gcm\0', 16),
    hkdf(ikm, salt, 'Content-Encoding: nonce\0', 12));
  decipher.setAuthTag(body.subarray(-16));
  const padded = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
  assert.equal(padded.at(-1), 2);
  return padded.subarray(0, -1);
}

test('encrypt matches the RFC 8291 test vector byte for byte', () => {
  const body = encrypt(Buffer.from(RFC.plaintext), RFC.uaPublic, RFC.auth, {
    salt: unb64u(RFC.salt),
    privateKey: unb64u(RFC.asPrivate),
  });
  assert.equal(body.toString('base64url'), RFC.body);
});

test('encrypt round-trips with random salt and key (test acts as user agent)', () => {
  const ua = crypto.createECDH('prime256v1');
  ua.generateKeys();
  const auth = crypto.randomBytes(16);
  const message = Buffer.from(JSON.stringify({ title: 'Halo', body: 'dunia \u{1F349}' }));
  const body = encrypt(message, ua.getPublicKey('base64url'), auth.toString('base64url'));
  assert.deepEqual(decrypt(body, ua.getPrivateKey(), auth), message);
  // and the RFC's own user-agent key decrypts the RFC body
  assert.equal(decrypt(unb64u(RFC.body), unb64u(RFC.uaPrivate), unb64u(RFC.auth)).toString(), RFC.plaintext);
});

test('publicKey is a stable 65-byte uncompressed point stored 0600', () => {
  const key = unb64u(publicKey());
  assert.equal(key.length, 65);
  assert.equal(key[0], 4);
  assert.equal(publicKey(), key.toString('base64url'));
  assert.equal(fs.statSync(path.join(dir, 'vapid.json')).mode & 0o777, 0o600);
});

test('VAPID JWT verifies with the public key', () => {
  const jwt = vapidJwt('https://push.example.net');
  const [header, claims, signature] = jwt.split('.');
  const point = unb64u(publicKey());
  const key = crypto.createPublicKey({
    format: 'jwk',
    key: { kty: 'EC', crv: 'P-256', x: point.subarray(1, 33).toString('base64url'), y: point.subarray(33).toString('base64url') },
  });
  assert.equal(unb64u(signature).length, 64);
  assert.ok(crypto.verify('sha256', Buffer.from(`${header}.${claims}`), { key, dsaEncoding: 'ieee-p1363' }, unb64u(signature)));
  assert.deepEqual(JSON.parse(unb64u(header)), { typ: 'JWT', alg: 'ES256' });
  const { aud, exp, sub } = JSON.parse(unb64u(claims));
  assert.equal(aud, 'https://push.example.net');
  assert.equal(sub, 'mailto:owner@example.com');
  const in12h = Math.floor(Date.now() / 1000) + 12 * 3600;
  assert.ok(exp <= in12h && exp > in12h - 60);
});

test('subscribe de-duplicates by endpoint and rejects non-https', () => {
  const file = path.join(dir, 'subscriptions.json');
  const keys = { p256dh: RFC.uaPublic, auth: RFC.auth };
  subscribe({ endpoint: 'https://push.example.net/a', keys });
  subscribe({ endpoint: 'https://push.example.net/a', keys });
  subscribe({ endpoint: 'https://push.example.net/b', keys });
  const subs = JSON.parse(fs.readFileSync(file, 'utf8'));
  assert.deepEqual(subs.map((s) => s.endpoint), ['https://push.example.net/a', 'https://push.example.net/b']);
  assert.equal(fs.statSync(file).mode & 0o777, 0o600);
  assert.throws(() => subscribe({ endpoint: 'http://push.example.net/c', keys }));
  assert.throws(() => subscribe({ endpoint: 'not a url', keys }));
  assert.equal(JSON.parse(fs.readFileSync(file, 'utf8')).length, 2);
});

test('sendPush posts an encrypted body, drops 410 subscriptions, maps network errors to 0', async (t) => {
  const calls = [];
  t.mock.method(globalThis, 'fetch', async (url, init) => {
    calls.push({ url, init });
    if (url.endsWith('/a')) return new Response(null, { status: 201 });
    if (url.endsWith('/b')) return new Response(null, { status: 410 });
    throw new Error('network down');
  });
  subscribe({ endpoint: 'https://push.example.net/c', keys: { p256dh: RFC.uaPublic, auth: RFC.auth } });

  const results = await sendPush({ title: 'Hi', body: 'there' });
  assert.deepEqual(results, [{ status: 201 }, { status: 410 }, { status: 0 }]);

  const { headers, body } = calls[0].init;
  assert.match(headers.Authorization, /^vapid t=[\w-]+\.[\w-]+\.[\w-]+, k=[\w-]+$/);
  assert.equal(headers['Content-Encoding'], 'aes128gcm');
  assert.equal(headers.TTL, '86400');
  assert.equal(headers.Urgency, 'high');
  assert.equal(decrypt(body, unb64u(RFC.uaPrivate), unb64u(RFC.auth)).toString(), '{"title":"Hi","body":"there"}');

  const left = JSON.parse(fs.readFileSync(path.join(dir, 'subscriptions.json'), 'utf8'));
  assert.deepEqual(left.map((s) => s.endpoint), ['https://push.example.net/a', 'https://push.example.net/c']);
  assert.equal(calls.length, 3); // no ntfy call without config.json
});

test('ntfyTopic in config.json adds one ntfy.sh post', async (t) => {
  const calls = [];
  t.mock.method(globalThis, 'fetch', async (url, init) => {
    calls.push({ url, init });
    return new Response(null, { status: 201 });
  });
  fs.writeFileSync(path.join(dir, 'config.json'), JSON.stringify({ ntfyTopic: 'test-topic' }));
  await sendPush({ title: 'Selesai ✓', body: 'there' });
  const ntfy = calls.at(-1);
  assert.equal(ntfy.url, 'https://ntfy.sh/test-topic');
  assert.equal(ntfy.init.body, 'there');
  new Headers(ntfy.init.headers); // throws if the title is not a legal header value
  fs.rmSync(path.join(dir, 'config.json'));
});
