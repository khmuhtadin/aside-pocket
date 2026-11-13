// Minimal QR code encoder: byte mode, error correction L, versions 1 to 6 (up to 134 bytes).
// qrMatrix(text) -> square array of booleans (true = dark). qrText(text) -> string to print in a terminal.

// [total data codewords, error correction codewords per block, blocks] for versions 1..6 at level L
const VERSIONS = [null, [19, 7, 1], [34, 10, 1], [55, 15, 1], [80, 20, 1], [108, 26, 1], [136, 18, 2]]

// multiplication in GF(256) with the QR polynomial
function mul(x, y) {
  let z = 0
  for (let i = 7; i >= 0; i--) {
    z = (z << 1) ^ ((z >>> 7) * 0x11d)
    z ^= ((y >>> i) & 1) * x
  }
  return z
}

// Reed-Solomon error correction codewords for one block
function errorCorrection(data, count) {
  const divisor = new Array(count).fill(0)
  divisor[count - 1] = 1
  let root = 1
  for (let i = 0; i < count; i++) {
    for (let j = 0; j < count; j++) {
      divisor[j] = mul(divisor[j], root)
      if (j + 1 < count) divisor[j] ^= divisor[j + 1]
    }
    root = mul(root, 2)
  }
  const rem = new Array(count).fill(0)
  for (const b of data) {
    const factor = b ^ rem.shift()
    rem.push(0)
    divisor.forEach((c, i) => (rem[i] ^= mul(c, factor)))
  }
  return rem
}

// text -> all codewords (data blocks interleaved, then their error correction)
function codewords(bytes, version) {
  const [total, ecCount, blocks] = VERSIONS[version]
  const bits = [0, 1, 0, 0] // byte mode
  const push = (value, length) => {
    for (let i = length - 1; i >= 0; i--) bits.push((value >>> i) & 1)
  }
  push(bytes.length, 8)
  for (const b of bytes) push(b, 8)
  push(0, Math.min(4, total * 8 - bits.length)) // terminator
  while (bits.length % 8) bits.push(0)
  const data = []
  for (let i = 0; i < bits.length; i += 8) data.push(parseInt(bits.slice(i, i + 8).join(''), 2))
  for (let pad = 0xec; data.length < total; pad ^= 0xec ^ 0x11) data.push(pad)

  const size = total / blocks
  const parts = []
  for (let b = 0; b < blocks; b++) parts.push(data.slice(b * size, (b + 1) * size))
  const ecs = parts.map((part) => errorCorrection(part, ecCount))
  const out = []
  for (let i = 0; i < size; i++) for (const part of parts) out.push(part[i])
  for (let i = 0; i < ecCount; i++) for (const ec of ecs) out.push(ec[i])
  return out
}

const MASKS = [
  (x, y) => (x + y) % 2 === 0,
  (x, y) => y % 2 === 0,
  (x, y) => x % 3 === 0,
  (x, y) => (x + y) % 3 === 0,
  (x, y) => (Math.floor(x / 3) + Math.floor(y / 2)) % 2 === 0,
  (x, y) => ((x * y) % 2) + ((x * y) % 3) === 0,
  (x, y) => (((x * y) % 2) + ((x * y) % 3)) % 2 === 0,
  (x, y) => (((x + y) % 2) + ((x * y) % 3)) % 2 === 0,
]

// how hard a matrix is to scan (the standard's four rules); lower is better
function penalty(m) {
  const size = m.length
  let score = 0
  let dark = 0
  for (let a = 0; a < size; a++) {
    for (const line of [m[a], m.map((row) => row[a])]) {
      let run = 1
      for (let i = 1; i <= size; i++) {
        if (i < size && line[i] === line[i - 1]) run++
        else {
          if (run >= 5) score += run - 2
          run = 1
        }
      }
      const s = line.map((v) => (v ? '1' : '0')).join('')
      for (const pattern of ['10111010000', '00001011101']) {
        for (let i = s.indexOf(pattern); i !== -1; i = s.indexOf(pattern, i + 1)) score += 40
      }
    }
    for (let b = 0; b < size; b++) {
      if (m[a][b]) dark++
      if (a + 1 < size && b + 1 < size && m[a][b] === m[a][b + 1] && m[a][b] === m[a + 1][b] && m[a][b] === m[a + 1][b + 1]) score += 3
    }
  }
  return score + Math.floor(Math.abs((dark * 20) / (size * size) - 10)) * 10
}

export function qrMatrix(text) {
  const bytes = [...Buffer.from(text, 'utf8')]
  const version = VERSIONS.findIndex((v) => v && bytes.length <= v[0] - 2)
  if (version === -1) throw new Error('text too long for a QR code (max 134 bytes)')
  const size = 17 + 4 * version
  const m = Array.from({ length: size }, () => new Array(size).fill(false))
  const fixed = Array.from({ length: size }, () => new Array(size).fill(false)) // modules that are not data
  const set = (x, y, dark) => {
    if (x < 0 || y < 0 || x >= size || y >= size) return
    m[y][x] = dark
    fixed[y][x] = true
  }

  for (let i = 0; i < size; i++) {
    set(6, i, i % 2 === 0) // timing patterns
    set(i, 6, i % 2 === 0)
  }
  for (const [cx, cy] of [[3, 3], [size - 4, 3], [3, size - 4]]) {
    // finder patterns with their separators
    for (let dy = -4; dy <= 4; dy++) {
      for (let dx = -4; dx <= 4; dx++) {
        const d = Math.max(Math.abs(dx), Math.abs(dy))
        set(cx + dx, cy + dy, d !== 2 && d !== 4)
      }
    }
  }
  if (version > 1) {
    // one alignment pattern, bottom right
    for (let dy = -2; dy <= 2; dy++) {
      for (let dx = -2; dx <= 2; dx++) set(size - 7 + dx, size - 7 + dy, Math.max(Math.abs(dx), Math.abs(dy)) !== 1)
    }
  }
  const format = (mask) => {
    const data = (1 << 3) | mask // level L
    let rem = data
    for (let i = 0; i < 10; i++) rem = (rem << 1) ^ ((rem >>> 9) * 0x537)
    const bits = ((data << 10) | rem) ^ 0x5412
    const bit = (i) => ((bits >>> i) & 1) === 1
    for (let i = 0; i <= 5; i++) set(8, i, bit(i))
    set(8, 7, bit(6))
    set(8, 8, bit(7))
    set(7, 8, bit(8))
    for (let i = 9; i < 15; i++) set(14 - i, 8, bit(i))
    for (let i = 0; i < 8; i++) set(size - 1 - i, 8, bit(i))
    for (let i = 8; i < 15; i++) set(8, size - 15 + i, bit(i))
    set(8, size - 8, true)
  }
  format(0) // reserves the format area before the data goes in

  const data = codewords(bytes, version)
  let i = 0
  for (let right = size - 1; right >= 1; right -= 2) {
    if (right === 6) right = 5
    for (let vert = 0; vert < size; vert++) {
      for (let j = 0; j < 2; j++) {
        const x = right - j
        const y = ((right + 1) & 2) === 0 ? size - 1 - vert : vert
        if (fixed[y][x] || i >= data.length * 8) continue
        m[y][x] = ((data[i >>> 3] >>> (7 - (i & 7))) & 1) === 1
        i++
      }
    }
  }

  const applyMask = (mask) => {
    for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) if (!fixed[y][x] && MASKS[mask](x, y)) m[y][x] = !m[y][x]
  }
  let best = 0
  let bestScore = Infinity
  for (let mask = 0; mask < 8; mask++) {
    applyMask(mask)
    format(mask)
    const score = penalty(m)
    if (score < bestScore) [best, bestScore] = [mask, score]
    applyMask(mask) // undo
  }
  applyMask(best)
  format(best)
  return m
}

// Black on white with a quiet zone, two rows per text line, so it scans from any terminal theme.
export function qrText(text) {
  const m = qrMatrix(text)
  const size = m.length
  const dark = (x, y) => x >= 0 && y >= 0 && x < size && y < size && m[y][x]
  const lines = []
  for (let y = -2; y < size + 2; y += 2) {
    let line = ''
    for (let x = -4; x < size + 4; x++) line += dark(x, y) ? (dark(x, y + 1) ? '█' : '▀') : dark(x, y + 1) ? '▄' : ' '
    lines.push('\x1b[47m\x1b[30m' + line + '\x1b[0m')
  }
  return lines.join('\n')
}
