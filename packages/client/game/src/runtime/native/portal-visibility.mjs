// Pure CPU workspace. Typed arrays stay private: callers provide topology and
// immutable summaries, and receive only the conservative visibility set.
const directions = [[-1, 0, 0], [1, 0, 0], [0, -1, 0], [0, 1, 0], [0, 0, -1], [0, 0, 1]];
const keyOf = (x, y, z) => `${x}:${y}:${z}`;
const rowDivisors = [1, 64, 4096, 262144, 16777216, 1073741824];

export function createPortalVisibilityWorkspace() {
  let keys = [], neighbours = new Int32Array(0), connected = new Uint8Array(0);
  let visible = new Uint8Array(0), emitted = new Uint8Array(0), queue = new Int32Array(0), start = -1;
  let published = new Uint8Array(0), revision = 0;
  const result = new Set(), indices = new Map();
  let coordinates = new Float64Array(0), grid = new Int32Array(0);

  function rebuild(candidates, center) {
    revision++;
    indices.clear(); keys.length = 0;
    let minX = Infinity, minY = Infinity, minZ = Infinity, maxX = -Infinity, maxY = -Infinity, maxZ = -Infinity;
    for (const position of candidates) {
      const {x, y, z} = position, key = keyOf(x, y, z);
      if (indices.has(key)) continue;
      const i = keys.length;
      if (i === connected.length) {
        const capacity = Math.max(64, i * 2);
        neighbours = new Int32Array(capacity * 6);
        connected = new Uint8Array(capacity);
        visible = new Uint8Array(capacity);
        emitted = new Uint8Array(capacity);
        published = new Uint8Array(capacity);
        queue = new Int32Array(capacity * 6);
        const next = new Float64Array(capacity * 3);
        next.set(coordinates); coordinates = next;
      }
      indices.set(key, i); keys.push(key);
      coordinates[i * 3] = x; coordinates[i * 3 + 1] = y; coordinates[i * 3 + 2] = z;
      minX = Math.min(minX, x); minY = Math.min(minY, y); minZ = Math.min(minZ, z);
      maxX = Math.max(maxX, x); maxY = Math.max(maxY, y); maxZ = Math.max(maxZ, z);
    }
    const size = keys.length, width = maxX - minX + 3, height = maxY - minY + 3;
    published.fill(0, 0, size);
    const plane = width * height, volume = plane * (maxZ - minZ + 3);
    // Local stream windows fit a small padded grid. Integer strides avoid six
    // temporary strings and hash lookups per node on every topology refresh.
    // Sparse/distant candidates retain the bounded map path.
    if (Number.isSafeInteger(volume) && volume <= Math.max(1024, size * 32) && volume <= 262144) {
      if (grid.length < volume) grid = new Int32Array(volume);
      else grid.fill(0, 0, volume);
      const cell = i => coordinates[i * 3] - minX + 1 + (coordinates[i * 3 + 1] - minY + 1) * width + (coordinates[i * 3 + 2] - minZ + 1) * plane;
      for (let i = 0; i < size; i++) grid[cell(i)] = i + 1;
      for (let i = 0; i < size; i++) {
        const index = cell(i), offset = i * 6;
        neighbours[offset] = grid[index - 1] - 1; neighbours[offset + 1] = grid[index + 1] - 1;
        neighbours[offset + 2] = grid[index - width] - 1; neighbours[offset + 3] = grid[index + width] - 1;
        neighbours[offset + 4] = grid[index - plane] - 1; neighbours[offset + 5] = grid[index + plane] - 1;
      }
    } else for (let i = 0; i < size; i++) {
      const x = coordinates[i * 3], y = coordinates[i * 3 + 1], z = coordinates[i * 3 + 2];
      for (let face = 0; face < 6; face++) {
        const [dx, dy, dz] = directions[face];
        neighbours[i * 6 + face] = indices.get(keyOf(x + dx, y + dy, z + dz)) ?? -1;
      }
    }
    start = indices.get(keyOf(center.x, center.y, center.z)) ?? -1;
    connected.fill(0, 0, size);
    if (start < 0) return;
    connected[start] = 1; queue[0] = start;
    let head = 0, tail = 1;
    while (head < tail) {
      const offset = queue[head++] * 6;
      for (let face = 0; face < 6; face++) {
        const next = neighbours[offset + face];
        if (next < 0 || connected[next]) continue;
        connected[next] = 1; queue[tail++] = next;
      }
    }
  }

  function visibleChunkKeys(summaries) {
    result.clear();
    if (start < 0) { for (const key of keys) result.add(key); return result; }
    visible.fill(0, 0, keys.length); emitted.fill(0, 0, keys.length);
    let head = 0, tail = 0;
    function emit(index, faces) {
      const pending = faces & ~emitted[index];
      emitted[index] |= pending;
      for (let face = 0; face < 6; face++) if (pending & (1 << face)) queue[tail++] = index * 6 + face;
    }
    visible[start] = 1;
    const center = summaries.get(keys[start]);
    if (!center) emit(start, 63);
    else if (!center.fullyOccluding) emit(start, center.openFaces);
    while (head < tail) {
      const step = queue[head++], next = neighbours[step];
      if (next < 0 || emitted[next] === 63) continue;
      visible[next] = 1;
      const summary = summaries.get(keys[next]);
      if (!summary) { emit(next, 63); continue; }
      const incoming = (step % 6) ^ 1;
      if (summary.fullyOccluding || !(summary.openFaces & (1 << incoming))) continue;
      // The table is 36 bits; a JS bit shift would lose its last four bits.
      emit(next, Math.floor(summary.connectedFaces / rowDivisors[incoming]) & summary.openFaces & 63);
    }
    let changed = false;
    for (let i = 0; i < keys.length; i++) {
      const included = visible[i] || !connected[i] ? 1 : 0;
      if (published[i] !== included) changed = true;
      published[i] = included;
      if (included) result.add(keys[i]);
    }
    // Portal masks can change without changing any demanded chunk. Callers
    // only need to revisit residency/cache policy when this output changes.
    if (changed) revision++;
    return result;
  }
  return {rebuild, visibleChunkKeys, revision: () => revision};
}
