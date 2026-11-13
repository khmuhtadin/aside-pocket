import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { transcribe, fileName } from '../voice.js';

// Key from the shell or from ~/.aside-pocket/env (KEY=VALUE lines). Never printed.
function findKey() {
  if (process.env.GROQ_API_KEY) return process.env.GROQ_API_KEY;
  const file = path.join(os.homedir(), '.aside-pocket', 'env');
  if (!fs.existsSync(file)) return '';
  const line = fs.readFileSync(file, 'utf8').split('\n').find((l) => l.startsWith('GROQ_API_KEY='));
  return line ? line.slice('GROQ_API_KEY='.length).trim() : '';
}
const realKey = findKey();

// 1 second, 16 kHz, mono, 16-bit PCM, 440 Hz sine.
function wav() {
  const rate = 16000;
  const buf = Buffer.alloc(44 + rate * 2);
  buf.write('RIFF', 0);
  buf.writeUInt32LE(36 + rate * 2, 4);
  buf.write('WAVEfmt ', 8);
  buf.writeUInt32LE(16, 16);
  buf.writeUInt16LE(1, 20); // PCM
  buf.writeUInt16LE(1, 22); // mono
  buf.writeUInt32LE(rate, 24);
  buf.writeUInt32LE(rate * 2, 28);
  buf.writeUInt16LE(2, 32);
  buf.writeUInt16LE(16, 34);
  buf.write('data', 36);
  buf.writeUInt32LE(rate * 2, 40);
  for (let i = 0; i < rate; i++) {
    buf.writeInt16LE(Math.round(8000 * Math.sin((2 * Math.PI * 440 * i) / rate)), 44 + i * 2);
  }
  return buf;
}

test('file name follows the mime type', () => {
  assert.equal(fileName('audio/mp4'), 'audio.m4a');
  assert.equal(fileName('audio/webm'), 'audio.webm');
  assert.equal(fileName('audio/webm;codecs=opus'), 'audio.webm');
  assert.equal(fileName('audio/wav'), 'audio.wav');
  assert.equal(fileName('application/octet-stream'), 'audio.wav');
});

test('missing key throws 503', async () => {
  process.env.GROQ_API_KEY = '';
  await assert.rejects(transcribe(wav(), 'audio/wav'), { status: 503, message: 'GROQ_API_KEY missing' });
});

test('request shape, and non-2xx becomes 502 without echoing the key', async (t) => {
  process.env.GROQ_API_KEY = 'test-key-not-real';
  const calls = [];
  let status = 200;
  t.mock.method(globalThis, 'fetch', async (url, init) => {
    calls.push({ url, init });
    return Response.json({ text: 'halo' }, { status });
  });

  assert.equal(await transcribe(wav(), 'audio/mp4'), 'halo');
  const { url, init } = calls[0];
  assert.equal(url, 'https://api.groq.com/openai/v1/audio/transcriptions');
  assert.equal(init.headers.Authorization, 'Bearer test-key-not-real');
  assert.equal(init.body.get('model'), 'whisper-large-v3-turbo');
  assert.equal(init.body.get('response_format'), 'json');
  assert.equal(init.body.get('file').name, 'audio.m4a');

  status = 401;
  await assert.rejects(transcribe(wav(), 'audio/wav'), (err) => {
    assert.equal(err.status, 502);
    assert.ok(!err.message.includes('test-key-not-real'));
    return true;
  });
});

test('real Groq call with a 1 second WAV', { skip: realKey ? false : 'GROQ_API_KEY not set' }, async () => {
  process.env.GROQ_API_KEY = realKey;
  const text = await transcribe(wav(), 'audio/wav');
  assert.equal(typeof text, 'string');
  console.log(`Groq HTTP 200, transcript length ${text.length}`);
});
