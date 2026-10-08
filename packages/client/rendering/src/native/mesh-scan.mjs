// Catalog lookup and coarse culling happen once per padded voxel. Detailed
// material/UV/AO emission still owns the final geometry and ordering.
export function scanChunkGeometry(edge, blocks, states) {
  const padded = edge + 2, plane = padded * padded, volume = edge ** 3;
  if (blocks.length !== padded ** 3) throw new Error("Invalid padded Chunk volume");
  const flags = new Uint8Array(blocks.length), cached = new Map();
  for (let i = 0; i < blocks.length; i++) {
    const id = blocks[i];
    let flag = cached.get(id);
    if (flag === undefined) {
      const state = states.get(id);
      if (!state) throw new Error(`Chunk references unknown runtimeId ${id}`);
      const box = (state.model === "cube" || state.model === "column") && state.geometry == null;
      flag = (state.model == null ? 0 : 1) | (state.occludes ? 2 : 0)
        | (box && state.occludes ? 4 : 0) | (box && state.attachments.length === 0 ? 8 : 0);
      cached.set(id, flag);
    }
    flags[i] = flag;
  }
  const closed = new Uint8Array(volume), indices = new Uint32Array(volume);
  let visibleBlocks = 0, count = 0, opaque = 0, index = 0;
  for (let y = 0; y < edge; y++) for (let z = 0; z < edge; z++) for (let x = 0; x < edge; x++, index++) {
    const i = x + 1 + padded * (z + 1) + plane * (y + 1), flag = flags[i];
    if (flag & 2) { closed[index] = 1; opaque++; }
    if (!(flag & 1)) continue;
    visibleBlocks++;
    if ((flag & 8) && (flags[i - 1] & flags[i + 1] & flags[i - padded] & flags[i + padded]
      & flags[i - plane] & flags[i + plane] & 4)) continue;
    indices[count++] = index;
  }
  let openFaces = 0, connectedFaces = 0;
  if (opaque === 0) { openFaces = 63; connectedFaces = 2 ** 36 - 1; }
  else if (opaque !== volume) {
    const queue = new Uint32Array(volume), rows = new Uint8Array(6), area = edge * edge;
    for (let start = 0; start < volume; start++) {
      if (closed[start]) continue;
      let head = 0, tail = 1, faces = 0;
      queue[0] = start; closed[start] = 1;
      function visit(i) { if (!closed[i]) { closed[i] = 1; queue[tail++] = i; } }
      while (head < tail) {
        const i = queue[head++], x = i % edge, z = Math.floor(i / edge) % edge, y = Math.floor(i / area);
        if (x === 0) faces |= 1; else visit(i - 1);
        if (x === edge - 1) faces |= 2; else visit(i + 1);
        if (y === 0) faces |= 4; else visit(i - area);
        if (y === edge - 1) faces |= 8; else visit(i + area);
        if (z === 0) faces |= 16; else visit(i - edge);
        if (z === edge - 1) faces |= 32; else visit(i + edge);
      }
      openFaces |= faces;
      for (let face = 0; face < 6; face++) if (faces & (1 << face)) rows[face] |= faces;
    }
    for (let face = 0; face < 6; face++) connectedFaces += rows[face] * 2 ** (face * 6);
  }
  return {indices: indices.slice(0, count), visibleBlocks,
    portalSummary: {empty: visibleBlocks === 0, fullyOccluding: opaque === volume, openFaces, connectedFaces}};
}
