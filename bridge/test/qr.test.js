import test from 'node:test'
import assert from 'node:assert/strict'
import { qrMatrix, qrText } from '../qr.js'

test('qr: size follows the text length, finder patterns are in three corners', () => {
  assert.equal(qrMatrix('hi').length, 21) // version 1
  const m = qrMatrix('https://example-mac.tailnet-name.ts.net:8443/#/pair/123456')
  assert.equal(m.length, 33) // version 4
  const finder = (x, y) => [0, 1, 2, 3, 4, 5, 6].map((i) => m[y][x + i]).join()
  assert.equal(finder(0, 0), 'true,true,true,true,true,true,true')
  assert.equal(finder(26, 0), 'true,true,true,true,true,true,true')
  assert.equal(finder(0, 32), 'true,true,true,true,true,true,true')
  assert.equal(m[1][1], false)
  assert.equal(m[3][3], true)
  assert.equal(m[25][8], true) // the always-dark module
})

test('qr: same text gives the same code, long text is refused', () => {
  assert.deepEqual(qrMatrix('abc'), qrMatrix('abc'))
  assert.throws(() => qrMatrix('x'.repeat(135)), /too long/)
  assert.equal(qrText('hi').split('\n').length, 13) // 21 modules + quiet zone, two rows per line
})
