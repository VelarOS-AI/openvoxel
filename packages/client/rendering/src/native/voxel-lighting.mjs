const keyOf = p => `${p.x}:${p.y}:${p.z}`;
const columnOf = p => `${p.x}:${p.z}`;
const equalBytes = (a, b) => {
  if (!a || a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
};

/** CPU-only worker field. Day/night never rebuilds this geometric visibility.
 * Unknown neighbours cannot inject light. Remembered column roofs survive a
 * vertical eviction so descending into a cave cannot reopen its ceiling. */
export function createVoxelLightField(edge, states) {
  const catalog = new Map(states.map(state => [state.runtimeId, state]));
  const chunks = new Map(), columnRoofs = new Map();
  let cachedSources = [];
  const area = edge * edge, volume = area * edge, padded = edge + 2;
  const coordinates = Array.from({length: volume}, (_, i) => [i % edge, Math.floor(i / area), Math.floor(i / edge) % edge]);

  function install(input) {
    if (input.blocks.length !== volume) throw new Error("Lighting Chunk volume does not match its edge");
    const opacity = new Uint8Array(volume), emission = new Uint8Array(volume), directLoss = new Uint8Array(volume);
    const roof = new Int32Array(area).fill(-2147483648);
    for (let i = 0; i < volume; i++) {
      const state = catalog.get(input.blocks[i]);
      if (!state) throw new Error(`Unknown lighting state ${input.blocks[i]}`);
      opacity[i] = state.opacity;
      emission[i] = state.emission;
      directLoss[i] = state.passesSkylight ? 0 : Math.max(1, state.opacity);
      if (state.opacity === 15) roof[i % area] = input.position.y * edge + Math.floor(i / area);
    }
    const previous = chunks.get(keyOf(input.position));
    // Crop stages, grass/flower swaps and texture changes commonly preserve
    // optical properties. Keep settled light and skip the flood in that case.
    if (previous && opacity.every((value, i) => value === previous.opacity[i]
      && emission[i] === previous.emission[i] && directLoss[i] === previous.directLoss[i])) return false;
    const columnKey = columnOf(input.position);
    let roofs = columnRoofs.get(columnKey);
    if (!roofs) { roofs = new Map(); columnRoofs.set(columnKey, roofs); }
    roofs.set(input.position.y, roof);
    const representatives = new Map(), p = input.position;
    for (let i = 0; i < volume; i++) if (emission[i] >= 8) {
      const [x, y, z] = coordinates[i], level = emission[i];
      const key = `${x >> 2}:${y >> 2}:${z >> 2}`;
      if ((representatives.get(key)?.level ?? 0) < level) representatives.set(key,
        {x: p.x * edge + x + 0.5, y: p.y * edge + y + 0.75, z: p.z * edge + z + 0.5, level});
    }
    chunks.set(keyOf(input.position), {position: input.position, opacity, emission, directLoss, sources: [...representatives.values()],
      direct: new Uint8Array(volume), sky: new Uint8Array(volume), block: new Uint8Array(volume), previous: previous?.previous});
    return true;
  }

  function solve(inputs, removed) {
    if (inputs.length === 0 && removed.length === 0) return {chunks: [], removed: [], sources: cachedSources};
    removed = removed.filter(position => chunks.has(keyOf(position)));
    for (const position of removed) chunks.delete(keyOf(position));
    inputs = inputs.filter(install);
    if (inputs.length === 0 && removed.length === 0) return {chunks: [], removed: [], sources: cachedSources};
    // A level-15 source travels at most 14 cells horizontally. Recompute the
    // affected columns plus that halo, retaining settled light beyond it.
    // Whole columns are included because direct skylight has no vertical loss.
    const affected = new Set(), outputColumns = new Set();
    const radius = Math.ceil(14 / edge);
    for (const p of [...inputs.map(input => input.position), ...removed]) {
      for (let x = -radius - 1; x <= radius + 1; x++) for (let z = -radius - 1; z <= radius + 1; z++) {
        const key = `${p.x + x}:${p.z + z}`;
        outputColumns.add(key);
        if (Math.abs(x) <= radius && Math.abs(z) <= radius) affected.add(key);
      }
    }
    const ordered = [...chunks.values()];
    const columns = new Map();
    ordered.forEach((chunk, index) => {
      chunk.index = index;
      const key = columnOf(chunk.position), column = columns.get(key) ?? [];
      chunk.active = affected.has(key);
      if (chunk.active) { chunk.sky.fill(0); chunk.direct.fill(0); chunk.block.set(chunk.emission); }
      column.push(chunk); columns.set(key, column);
    });
    for (const key of columnRoofs.keys()) if (!columns.has(key)) columnRoofs.delete(key);
    for (const chunk of ordered) {
      const p = chunk.position;
      chunk.neighbours = [[-1, 0, 0], [1, 0, 0], [0, -1, 0], [0, 1, 0], [0, 0, -1], [0, 0, 1]]
        .map(([x, y, z]) => chunks.get(keyOf({x: p.x + x, y: p.y + y, z: p.z + z})));
    }
    for (const [key, column] of columns) {
      if (!affected.has(key)) continue;
      column.sort((a, b) => b.position.y - a.position.y);
      const highestRoof = new Int32Array(area).fill(-2147483648);
      for (const roof of columnRoofs.get(key).values()) for (let i = 0; i < area; i++) highestRoof[i] = Math.max(highestRoof[i], roof[i]);
      for (let horizontal = 0; horizontal < area; horizontal++) {
        let level = highestRoof[horizontal] >= (column[0].position.y + 1) * edge ? 0 : 15;
        let previousY = column[0].position.y + 1;
        for (const chunk of column) {
          if (previousY !== chunk.position.y + 1) level = 0;
          previousY = chunk.position.y;
          for (let y = edge - 1; y >= 0; y--) {
            const i = horizontal + y * area;
            level = Math.max(0, level - chunk.directLoss[i]);
            chunk.direct[i] = chunk.sky[i] = level;
          }
        }
      }
    }

    function flood(channel) {
      // Descending buckets settle stronger paths before weaker ones. A deletion
      // starts from authoritative seeds, so old light cannot feed itself forever.
      const buckets = Array.from({length: 16}, () => []);
      for (const chunk of ordered) if (chunk.active) for (let i = 0; i < volume; i++) {
        const level = chunk[channel][i];
        if (level > 1) buckets[level].push(chunk.index * volume + i);
      }
      const spread = (target, offset, level) => {
        if (!target?.active) return;
        const next = level - Math.max(1, target.opacity[offset]);
        if (next <= target[channel][offset]) return;
        target[channel][offset] = next;
        if (next > 1) buckets[next].push(target.index * volume + offset);
      };
      // Unchanged neighbours provide fixed boundary values. They are outside
      // every changed source's reach, including removal/occluder updates.
      for (const chunk of ordered) if (chunk.active) for (let face = 0; face < 6; face++) {
        const neighbour = chunk.neighbours[face];
        if (!neighbour || neighbour.active) continue;
        for (let a = 0; a < edge; a++) for (let b = 0; b < edge; b++) {
          const offset = face < 2 ? b * area + a * edge + (face === 0 ? 0 : edge - 1)
            : face < 4 ? a + b * edge + (face === 2 ? 0 : (edge - 1) * area)
              : a + b * area + (face === 4 ? 0 : (edge - 1) * edge);
          const stride = face < 2 ? 1 : face < 4 ? area : edge;
          const other = offset + (face % 2 === 0 ? 1 : -1) * (edge - 1) * stride;
          spread(chunk, offset, neighbour[channel][other]);
        }
      }
      for (let level = 15; level > 1; level--) {
        const bucket = buckets[level];
        for (const node of bucket) {
          const chunk = ordered[Math.floor(node / volume)], i = node % volume;
          if (chunk[channel][i] !== level) continue;
          const [x, y, z] = coordinates[i], n = chunk.neighbours;
          spread(x > 0 ? chunk : n[0], x > 0 ? i - 1 : i + edge - 1, level);
          spread(x < edge - 1 ? chunk : n[1], x < edge - 1 ? i + 1 : i - edge + 1, level);
          spread(y > 0 ? chunk : n[2], y > 0 ? i - area : i + (edge - 1) * area, level);
          spread(y < edge - 1 ? chunk : n[3], y < edge - 1 ? i + area : i - (edge - 1) * area, level);
          spread(z > 0 ? chunk : n[4], z > 0 ? i - edge : i + (edge - 1) * edge, level);
          spread(z < edge - 1 ? chunk : n[5], z < edge - 1 ? i + edge : i - (edge - 1) * edge, level);
        }
        buckets[level] = null;
      }
    }
    flood("sky"); flood("block");

    const output = [], sources = [];
    for (const chunk of ordered) {
      sources.push(...chunk.sources);
      const p = chunk.position;
      if (!outputColumns.has(columnOf(p))) continue;
      const data = new Uint8Array(padded ** 3 * 4);
      for (let y = -1; y <= edge; y++) for (let z = -1; z <= edge; z++) for (let x = -1; x <= edge; x++) {
        const dx = Math.floor(x / edge), dy = Math.floor(y / edge), dz = Math.floor(z / edge);
        const neighbour = dx === 0 && dy === 0 && dz === 0 ? chunk : chunks.get(keyOf({x: p.x + dx, y: p.y + dy, z: p.z + dz}));
        // WebGL 3D texture order is x, then y, then z (world voxel storage is x,z,y).
        const to = ((x + 1) + padded * ((y + 1) + padded * (z + 1))) * 4;
        if (!neighbour) { data[to + 3] = 255; continue; }
        const from = (x - dx * edge) + edge * ((z - dz * edge) + edge * (y - dy * edge));
        data[to] = neighbour.direct[from] * 17;
        data[to + 1] = neighbour.sky[from] * 17;
        data[to + 2] = neighbour.block[from] * 17;
        data[to + 3] = neighbour.opacity[from] * 17;
      }
      if (!equalBytes(chunk.previous, data)) {
        chunk.previous = data;
        // Keep worker-owned bytes separate from the transferred response.
        output.push({position: p, edge, data: data.slice()});
      }
    }
    cachedSources = sources;
    return {chunks: output, removed, sources};
  }
  return {solve};
}
