// Pairing code and bearer token, stored in the data directory with mode 0600.
import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import { writeSecret } from './config.js'

const PAIR_TTL_MS = 5 * 60 * 1000
const MAX_ATTEMPTS = 5

const sha256 = (text) => crypto.createHash('sha256').update(text).digest('hex')

// makes a new one-time code, stores only its hash, returns the code
export function createPairCode(dir, now = Date.now()) {
  const code = String(crypto.randomInt(0, 1000000)).padStart(6, '0')
  writeSecret(path.join(dir, 'pair.json'), JSON.stringify({ hash: sha256(code), expires: now + PAIR_TTL_MS, attempts: 0 }))
  return code
}

// returns the bearer token when the code is right, otherwise null
export function redeemPairCode(dir, code, now = Date.now()) {
  const file = path.join(dir, 'pair.json')
  if (!fs.existsSync(file)) return null
  const pair = JSON.parse(fs.readFileSync(file, 'utf8'))
  if (now > pair.expires) {
    fs.rmSync(file)
    return null
  }
  if (sha256(String(code)) !== pair.hash) {
    pair.attempts++
    if (pair.attempts >= MAX_ATTEMPTS) fs.rmSync(file)
    else writeSecret(file, JSON.stringify(pair))
    return null
  }
  fs.rmSync(file)
  const tokenFile = path.join(dir, 'token')
  if (!fs.existsSync(tokenFile)) writeSecret(tokenFile, crypto.randomBytes(32).toString('hex'))
  return fs.readFileSync(tokenFile, 'utf8').trim()
}

// checks an `Authorization: Bearer <token>` header value
export function checkToken(dir, header) {
  const tokenFile = path.join(dir, 'token')
  if (!header || !header.startsWith('Bearer ') || !fs.existsSync(tokenFile)) return false
  const want = Buffer.from(fs.readFileSync(tokenFile, 'utf8').trim())
  const got = Buffer.from(header.slice(7))
  return got.length === want.length && crypto.timingSafeEqual(got, want)
}
