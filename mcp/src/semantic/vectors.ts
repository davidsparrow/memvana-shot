// Small helpers for unit-length float32 vectors stored as SQLite BLOBs.

/** Copies bytes into an aligned Float32Array (BLOBs and pooled Buffers may be unaligned). */
export function toVector(bytes: Uint8Array): Float32Array {
  return new Float32Array(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength));
}

export function toBlob(vector: Float32Array): Uint8Array {
  return new Uint8Array(vector.buffer, vector.byteOffset, vector.byteLength);
}

/** Cosine similarity of two unit vectors. */
export function cosine(a: Float32Array, b: Float32Array): number {
  let sum = 0;
  for (let i = 0; i < a.length; i++) sum += a[i]! * b[i]!;
  return sum;
}
