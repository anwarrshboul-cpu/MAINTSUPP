/**
 * MD5, for one purpose only: proving which bytes a direct-upload PART holds.
 *
 * NOT a security hash, and not used as one. S3 reports a stored part's ETag as
 * the MD5 of the bytes it holds. The browser computes the MD5 of each part it
 * sends and declares it at `complete`; the route compares that with the ETag
 * the BUCKET lists. Measured on Supabase Storage: a part URL accepted an
 * unsigned `x-amz-copy-source` header and stored ANOTHER object's bytes in the
 * part. A copied part carries the source's MD5, which a caller cannot declare
 * without already holding the source — so the comparison refuses the copy.
 *
 * WebCrypto has no MD5, hence this. RFC 1321, over a Uint8Array, returned as
 * lowercase hex; checked against the RFC's test suite and node:crypto.
 */

const S = [
  7, 12, 17, 22, 7, 12, 17, 22, 7, 12, 17, 22, 7, 12, 17, 22,
  5, 9, 14, 20, 5, 9, 14, 20, 5, 9, 14, 20, 5, 9, 14, 20,
  4, 11, 16, 23, 4, 11, 16, 23, 4, 11, 16, 23, 4, 11, 16, 23,
  6, 10, 15, 21, 6, 10, 15, 21, 6, 10, 15, 21, 6, 10, 15, 21,
];
const K = Array.from({ length: 64 }, (_, index) => Math.floor(Math.abs(Math.sin(index + 1)) * 2 ** 32) >>> 0);

export function md5Hex(input: Uint8Array): string {
  const length = input.length;
  // Message + 0x80 + zero padding + 64-bit little-endian bit length, to a multiple of 64 bytes.
  const padded = new Uint8Array((((length + 8) >>> 6) + 1) << 6);
  padded.set(input);
  padded[length] = 0x80;
  const bits = length * 8;
  const view = new DataView(padded.buffer);
  view.setUint32(padded.length - 8, bits >>> 0, true);
  view.setUint32(padded.length - 4, Math.floor(bits / 2 ** 32) >>> 0, true);

  let a0 = 0x67452301;
  let b0 = 0xefcdab89;
  let c0 = 0x98badcfe;
  let d0 = 0x10325476;
  const M = new Uint32Array(16);
  for (let offset = 0; offset < padded.length; offset += 64) {
    for (let word = 0; word < 16; word += 1) M[word] = view.getUint32(offset + word * 4, true);
    let a = a0;
    let b = b0;
    let c = c0;
    let d = d0;
    for (let step = 0; step < 64; step += 1) {
      let f: number;
      let g: number;
      if (step < 16) {
        f = (b & c) | (~b & d);
        g = step;
      } else if (step < 32) {
        f = (d & b) | (~d & c);
        g = (5 * step + 1) % 16;
      } else if (step < 48) {
        f = b ^ c ^ d;
        g = (3 * step + 5) % 16;
      } else {
        f = c ^ (b | ~d);
        g = (7 * step) % 16;
      }
      const sum = (a + f + K[step] + M[g]) >>> 0;
      a = d;
      d = c;
      c = b;
      b = (b + ((sum << S[step]) | (sum >>> (32 - S[step])))) >>> 0;
    }
    a0 = (a0 + a) >>> 0;
    b0 = (b0 + b) >>> 0;
    c0 = (c0 + c) >>> 0;
    d0 = (d0 + d) >>> 0;
  }
  const out = new DataView(new ArrayBuffer(16));
  out.setUint32(0, a0, true);
  out.setUint32(4, b0, true);
  out.setUint32(8, c0, true);
  out.setUint32(12, d0, true);
  return [...new Uint8Array(out.buffer)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}
