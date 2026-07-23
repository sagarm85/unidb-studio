// Word-hash embedding — exact JS port of demo/vector_demo.py embed().
// Uses MD5 per-word (matching Python's hashlib.md5) so vectors produced here
// are directly comparable to those stored in the demo `documents` table.
// Swap embed() for sentence-transformers in production; the SQL surface is identical.

function md5hex(str) {
  const bytes = new TextEncoder().encode(str);
  const origBitLen = bytes.length * 8;

  // Pad to multiple of 64 bytes: append 0x80, zeros, then 64-bit LE bit-length
  const padLen = Math.ceil((bytes.length + 9) / 64) * 64;
  const pad = new Uint8Array(padLen);
  pad.set(bytes);
  pad[bytes.length] = 0x80;
  new DataView(pad.buffer).setUint32(padLen - 8, origBitLen, /*LE=*/true);

  // Standard MD5 constants (RFC 1321)
  const K = new Int32Array([
    0xd76aa478,0xe8c7b756,0x242070db,0xc1bdceee,0xf57c0faf,0x4787c62a,0xa8304613,0xfd469501,
    0x698098d8,0x8b44f7af,0xffff5bb1,0x895cd7be,0x6b901122,0xfd987193,0xa679438e,0x49b40821,
    0xf61e2562,0xc040b340,0x265e5a51,0xe9b6c7aa,0xd62f105d,0x02441453,0xd8a1e681,0xe7d3fbc8,
    0x21e1cde6,0xc33707d6,0xf4d50d87,0x455a14ed,0xa9e3e905,0xfcefa3f8,0x676f02d9,0x8d2a4c8a,
    0xfffa3942,0x8771f681,0x6d9d6122,0xfde5380c,0xa4beea44,0x4bdecfa9,0xf6bb4b60,0xbebfbc70,
    0x289b7ec6,0xeaa127fa,0xd4ef3085,0x04881d05,0xd9d4d039,0xe6db99e5,0x1fa27cf8,0xc4ac5665,
    0xf4292244,0x432aff97,0xab9423a7,0xfc93a039,0x655b59c3,0x8f0ccc92,0xffeff47d,0x85845dd1,
    0x6fa87e4f,0xfe2ce6e0,0xa3014314,0x4e0811a1,0xf7537e82,0xbd3af235,0x2ad7d2bb,0xeb86d391,
  ]);
  const S = new Uint8Array([
    7,12,17,22, 7,12,17,22, 7,12,17,22, 7,12,17,22,
    5, 9,14,20, 5, 9,14,20, 5, 9,14,20, 5, 9,14,20,
    4,11,16,23, 4,11,16,23, 4,11,16,23, 4,11,16,23,
    6,10,15,21, 6,10,15,21, 6,10,15,21, 6,10,15,21,
  ]);

  let a0 = 0x67452301, b0 = 0xefcdab89 | 0, c0 = 0x98badcfe | 0, d0 = 0x10325476;

  for (let blk = 0; blk < padLen; blk += 64) {
    // Read 16 little-endian int32 words — native LE on all modern browsers
    const M = new Int32Array(pad.buffer, blk, 16);
    let a = a0, b = b0, c = c0, d = d0;
    for (let i = 0; i < 64; i++) {
      let F, g;
      if      (i < 16) { F = (b & c) | (~b & d); g = i; }
      else if (i < 32) { F = (d & b) | (~d & c); g = (5 * i + 1) % 16; }
      else if (i < 48) { F = b ^ c ^ d;           g = (3 * i + 5) % 16; }
      else             { F = c ^ (b | ~d);         g = (7 * i) % 16; }
      const tmp = d; d = c; c = b;
      const rot = (F + a + K[i] + M[g]) | 0;
      b = (b + ((rot << S[i]) | (rot >>> (32 - S[i])))) | 0;
      a = tmp;
    }
    a0 = (a0 + a) | 0; b0 = (b0 + b) | 0;
    c0 = (c0 + c) | 0; d0 = (d0 + d) | 0;
  }

  // Output: each word as little-endian hex (reverse byte pairs)
  return [a0, b0, c0, d0]
    .map(n => (n >>> 0).toString(16).padStart(8, '0').match(/../g).reverse().join(''))
    .join('');
}

const DIM = 64;

// Matches Python: embed(text) in vector_demo.py
export function embed(text) {
  const words = text.toLowerCase().split(/\s+/).filter(Boolean);
  const counts = new Array(DIM).fill(0);
  for (const w of words) {
    const bucket = Number(BigInt('0x' + md5hex(w)) % BigInt(DIM));
    counts[bucket] += 1;
  }
  const norm = Math.sqrt(counts.reduce((s, x) => s + x * x, 0)) || 1;
  return counts.map(x => Math.round(x / norm * 100) / 100);
}

// Format a vector as a SQL array literal: [0.0, 0.5, ...]
export function vectorToSql(vec) {
  return '[' + vec.join(', ') + ']';
}
