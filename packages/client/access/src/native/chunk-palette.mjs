// Pure typed-array expansion at the client-owned boundary. The small lookup is
// copied and validated once, instead of allocating checked property reads for
// every voxel. Cold indices and palette are never mutated or retained here.
export function expandChunkPalette(target, palette, indices) {
  if (!(target instanceof Uint32Array) || !(indices instanceof Uint16Array)
    || target.length !== indices.length) throw new RangeError("Chunk palette buffer dimensions do not match");
  const size = palette.length;
  if (!Number.isInteger(size) || size < 1 || size > 65536) throw new RangeError("Invalid Chunk palette size");
  const lookup = new Uint32Array(size);
  for (let index = 0; index < size; index += 1) {
    const value = palette[index];
    if (!Number.isInteger(value) || value < 0 || value > 0xffffffff) throw new RangeError("Chunk palette runtime ids must be UInt32 values");
    lookup[index] = value;
  }
  for (let index = 0; index < indices.length; index += 1) {
    const paletteIndex = indices[index];
    if (paletteIndex >= size) throw new RangeError("Chunk palette index is out of range");
    target[index] = lookup[paletteIndex];
  }
}
