// The caller supplies an owned snapshot, never the world's mutable storage.
// Copy contiguous x rows without per-voxel callbacks or temporary row views.
export function copyChunkInterior(target, source, edge) {
  const padded = edge + 2;
  if (!Number.isInteger(edge) || edge < 4 || edge > 64
    || source.length !== edge ** 3 || target.length !== padded ** 3) {
    throw new RangeError("Chunk snapshot buffer dimensions do not match edge");
  }
  let input = 0;
  for (let y = 1; y <= edge; y += 1) {
    for (let z = 1; z <= edge; z += 1) {
      const row = 1 + padded * (z + padded * y);
      for (let x = 0; x < edge; x += 1) target[row + x] = source[input++];
    }
  }
}
