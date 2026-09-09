export const precipitationColumnRadius = 7;
export const precipitationViewHalfHeight = 5;
export const precipitationColumnSampleBudget = 16;

function requirePositiveInteger(value, label) {
  if (!Number.isSafeInteger(value) || value < 1) throw new RangeError(label + " must be a positive integer");
  return value;
}

function requireNonNegativeFinite(value, label) {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
    throw new RangeError(label + " must be a non-negative finite number");
  }
  return value;
}

function requirePosition(value, label) {
  if (typeof value !== "object" || value === null) throw new TypeError(label + " must be a position");
  for (const axis of ["x", "y", "z"]) {
    if (typeof value[axis] !== "number" || !Number.isFinite(value[axis])) {
      throw new TypeError(label + " " + axis + " must be a finite number");
    }
  }
  return value;
}

function keyFor(x, z) {
  return x + ":" + z;
}

/** Integer XZ offsets for a bounded circular field, nearest columns first. */
export function precipitationColumnOffsets(radius = precipitationColumnRadius) {
  radius = requirePositiveInteger(radius, "Precipitation column radius");
  const offsets = [];
  for (let z = -radius; z <= radius; z += 1) {
    for (let x = -radius; x <= radius; x += 1) {
      const distanceSquared = x * x + z * z;
      if (distanceSquared <= radius * radius) offsets.push({x, z, distanceSquared});
    }
  }
  offsets.sort((left, right) => left.distanceSquared - right.distanceSquared || left.z - right.z || left.x - right.x);
  return offsets;
}

function normalizeGroundSample(value) {
  if (value == null) return {groundY: null, skyVisible: false, surface: "solid"};
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new TypeError("Precipitation ground height must be finite");
    return {groundY: value, skyVisible: true, surface: "solid"};
  }
  if (typeof value !== "object") {
    throw new TypeError("Precipitation ground query must return a height, a result record, or null");
  }
  if (value.groundY == null) return {groundY: null, skyVisible: false, surface: "solid"};
  if (typeof value.groundY !== "number" || !Number.isFinite(value.groundY)) {
    throw new TypeError("Precipitation ground result groundY must be finite");
  }
  if (value.skyVisible !== undefined && typeof value.skyVisible !== "boolean") {
    throw new TypeError("Precipitation ground result skyVisible must be boolean");
  }
  if (value.surface !== undefined && value.surface !== "water" && value.surface !== "solid") {
    throw new TypeError("Precipitation ground result surface must be water or solid");
  }
  return {groundY: value.groundY, skyVisible: value.skyVisible !== false, surface: value.surface ?? "solid"};
}

function horizontalForward(value) {
  if (typeof value !== "object" || value === null) return null;
  const x = value.x;
  const z = value.z;
  if (typeof x !== "number" || !Number.isFinite(x) || typeof z !== "number" || !Number.isFinite(z)) return null;
  const length = Math.hypot(x, z);
  if (length < 0.0001) return null;
  return {x: x / length, z: z / length};
}

/**
 * Keep the near column and the camera-facing half of the local weather field.
 * Columns span eye height, so horizontal and downward views retain weather.
 */
export function visiblePrecipitationColumns(columns, center, forward) {
  if (!Array.isArray(columns)) throw new TypeError("Precipitation columns must be an array");
  center = requirePosition(center, "Precipitation center");
  const facing = horizontalForward(forward);
  return columns.filter((column) => {
    if (column.groundY == null || column.skyVisible === false) return false;
    if (column.groundY >= center.y + precipitationViewHalfHeight) return false;
    const deltaX = column.x + 0.5 - center.x + (facing?.x ?? 0) * 0.7;
    const deltaZ = column.z + 0.5 - center.z + (facing?.z ?? 0) * 0.7;
    const distance = Math.hypot(deltaX, deltaZ);
    if (distance < 1.15 || facing === null) return true;
    return (deltaX * facing.x + deltaZ * facing.z) / distance > 0.5;
  });
}

/**
 * Incrementally samples a camera-local precipitation field. At most
 * `sampleBudget` ground callbacks run per update, even after teleporting.
 */
export function createPrecipitationColumnField(options = {}) {
  if (typeof options !== "object" || options === null) throw new TypeError("Precipitation field options must be a record");
  const radius = requirePositiveInteger(options.radius ?? precipitationColumnRadius, "Precipitation column radius");
  const sampleBudget = requirePositiveInteger(
    options.sampleBudget ?? precipitationColumnSampleBudget,
    "Precipitation column sample budget",
  );
  const refreshMilliseconds = requireNonNegativeFinite(
    options.refreshMilliseconds ?? 1_000,
    "Precipitation column refresh interval",
  );
  const offsets = precipitationColumnOffsets(radius);
  const samples = new Map();
  const pending = [];
  const pendingKeys = new Set();
  let desiredKeys = new Set();
  let centerX = null;
  let centerZ = null;
  let elapsedMilliseconds = 0;
  let sourceGroundAt = null;
  let fallbackGroundY = null;

  function queue(key) {
    if (pendingKeys.has(key)) return;
    pendingKeys.add(key);
    pending.push(key);
  }

  function rebuildDesired(nextCenterX, nextCenterZ) {
    desiredKeys = new Set();
    for (const offset of offsets) {
      const key = keyFor(nextCenterX + offset.x, nextCenterZ + offset.z);
      desiredKeys.add(key);
      if (!samples.has(key)) queue(key);
    }
    for (let index = pending.length - 1; index >= 0; index -= 1) {
      if (desiredKeys.has(pending[index])) continue;
      pendingKeys.delete(pending[index]);
      pending.splice(index, 1);
    }
    for (const key of samples.keys()) {
      if (!desiredKeys.has(key)) samples.delete(key);
    }
  }

  function clearSamples() {
    samples.clear();
    pending.length = 0;
    pendingKeys.clear();
    if (centerX !== null && centerZ !== null) rebuildDesired(centerX, centerZ);
  }

  return {
    invalidateChunkColumn(chunkX, chunkZ, chunkEdge) {
      if (!Number.isSafeInteger(chunkX) || !Number.isSafeInteger(chunkZ)) {
        throw new RangeError("Precipitation invalidation requires integer Chunk coordinates");
      }
      chunkEdge = requirePositiveInteger(chunkEdge, "Precipitation invalidation Chunk edge");
      const invalidated = [];
      for (const key of desiredKeys) {
        const separator = key.indexOf(":");
        const x = Number(key.slice(0, separator));
        const z = Number(key.slice(separator + 1));
        if (Math.floor(x / chunkEdge) !== chunkX || Math.floor(z / chunkEdge) !== chunkZ) continue;
        samples.delete(key);
        invalidated.push(key);
      }
      if (invalidated.length > 0) {
        const invalidatedKeys = new Set(invalidated);
        for (let index = pending.length - 1; index >= 0; index -= 1) {
          if (invalidatedKeys.has(pending[index])) pending.splice(index, 1);
        }
        // The bounded desired set is nearest-first. Refresh changed surfaces
        // ahead of periodic background refreshes without duplicating work.
        pending.unshift(...invalidated);
        for (const key of invalidated) pendingKeys.add(key);
      }
      return {cachedColumns: samples.size, pendingColumns: pending.length};
    },
    update(deltaMs, center, forward, fallbackGround, groundAt) {
      deltaMs = requireNonNegativeFinite(deltaMs, "Precipitation update delta");
      center = requirePosition(center, "Precipitation center");
      if (groundAt != null && typeof groundAt !== "function") {
        throw new TypeError("Precipitation groundAt must be a function, null, or undefined");
      }
      let nextFallbackGroundY = null;
      if (fallbackGround != null) nextFallbackGroundY = requirePosition(fallbackGround, "Precipitation fallback ground").y;
      const nextGroundAt = groundAt ?? null;
      const sourceChanged = (nextGroundAt === null) !== (sourceGroundAt === null)
        || (nextGroundAt === null && nextFallbackGroundY !== fallbackGroundY);
      sourceGroundAt = nextGroundAt;
      fallbackGroundY = nextFallbackGroundY;
      elapsedMilliseconds += deltaMs;

      const nextCenterX = Math.floor(center.x);
      const nextCenterZ = Math.floor(center.z);
      if (nextCenterX !== centerX || nextCenterZ !== centerZ) {
        centerX = nextCenterX;
        centerZ = nextCenterZ;
        rebuildDesired(centerX, centerZ);
      }
      if (sourceChanged) clearSamples();

      for (const [key, sample] of samples) {
        if (elapsedMilliseconds - sample.sampledAt >= refreshMilliseconds) queue(key);
      }

      let sampled = 0;
      while (sampled < sampleBudget && pending.length > 0) {
        const key = pending.shift();
        pendingKeys.delete(key);
        if (!desiredKeys.has(key)) continue;
        const separator = key.indexOf(":");
        const x = Number(key.slice(0, separator));
        const z = Number(key.slice(separator + 1));
        const value = sourceGroundAt === null ? fallbackGroundY : sourceGroundAt(x, z, center.y);
        samples.set(key, {x, z, ...normalizeGroundSample(value), sampledAt: elapsedMilliseconds});
        sampled += 1;
      }

      const columns = visiblePrecipitationColumns([...samples.values()], center, forward);
      return {
        columns,
        cachedColumns: samples.size,
        pendingColumns: pending.length,
        sampledColumns: sampled,
        maximumColumns: offsets.length,
      };
    },
    reset() {
      clearSamples();
    },
  };
}
