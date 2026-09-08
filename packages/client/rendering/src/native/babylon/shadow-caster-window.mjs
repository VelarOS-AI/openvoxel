function requireFunction(value, label) {
  if (typeof value !== "function") throw new TypeError(label + " must be a function");
  return value;
}

function requirePositiveFinite(value, label) {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) {
    throw new RangeError(label + " must be a positive finite number");
  }
  return value;
}

function requireNonNegativeFinite(value, label) {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
    throw new RangeError(label + " must be a non-negative finite number");
  }
  return value;
}

function requirePosition(value, label) {
  if (typeof value !== "object" || value === null) throw new TypeError(label + " must be a position record");
  for (const axis of ["x", "y", "z"]) {
    if (typeof value[axis] !== "number" || !Number.isFinite(value[axis])) {
      throw new TypeError(`${label} ${axis} must be finite`);
    }
  }
  return value;
}

function chunkKey(position, edge) {
  return `${Math.floor(position.x / edge)}:${Math.floor(position.y / edge)}:${Math.floor(position.z / edge)}`;
}

/// Snap the light's transverse axes to shadow texels. Small camera motions then
/// reuse the same projection instead of making voxel shadow edges crawl.
export function shadowLightPosition(position, direction, frustumSize, mapSize, lightDistance) {
  const horizontalLength = Math.hypot(direction.x, direction.z);
  const right = horizontalLength < 0.000001
    ? {x: 1, y: 0, z: 0}
    : {x: direction.z / horizontalLength, y: 0, z: -direction.x / horizontalLength};
  const up = {
    x: direction.y * right.z,
    y: direction.z * right.x - direction.x * right.z,
    z: -direction.y * right.x,
  };
  const dot = (axis) => position.x * axis.x + position.y * axis.y + position.z * axis.z;
  const texelSize = frustumSize / mapSize;
  const transverseX = Math.round(dot(right) / texelSize) * texelSize;
  const transverseY = Math.round(dot(up) / texelSize) * texelSize;
  const depth = Math.round(dot(direction)) - lightDistance;
  return {
    x: right.x * transverseX + up.x * transverseY + direction.x * depth,
    y: right.y * transverseX + up.y * transverseY + direction.y * depth,
    z: right.z * transverseX + up.z * transverseY + direction.z * depth,
  };
}

/// Coalesces repeated shadow-map invalidations while preserving an immediate
/// first render. Callers commit the light transform and reset the render target
/// together only when `advance` returns true, so a cached map is never sampled
/// with a newer projection matrix.
export class ShadowRefreshScheduler {
  constructor(minimumIntervalMilliseconds) {
    this.minimumIntervalMilliseconds = requirePositiveFinite(
      minimumIntervalMilliseconds,
      "Shadow refresh interval",
    );
    this.elapsedMilliseconds = this.minimumIntervalMilliseconds;
    this.dirty = true;
  }

  invalidate(immediate = false) {
    if (typeof immediate !== "boolean") throw new TypeError("Shadow refresh immediate flag must be boolean");
    this.dirty = true;
    if (immediate) this.elapsedMilliseconds = this.minimumIntervalMilliseconds;
  }

  advance(deltaMilliseconds) {
    const delta = requireNonNegativeFinite(deltaMilliseconds, "Shadow refresh delta");
    this.elapsedMilliseconds = Math.min(
      this.minimumIntervalMilliseconds,
      this.elapsedMilliseconds + delta,
    );
    if (!this.dirty || this.elapsedMilliseconds < this.minimumIntervalMilliseconds) return false;
    this.dirty = false;
    this.elapsedMilliseconds = 0;
    return true;
  }
}

/// Keeps the authoritative caster set independent from the much smaller set
/// submitted to the directional shadow map. Selection changes only when the
/// camera crosses a Chunk boundary or caster ownership changes.
export class ShadowCasterWindow {
  constructor({edge, radius, activate, deactivate}) {
    this.edge = requirePositiveFinite(edge, "Shadow caster Chunk edge");
    this.radiusSquared = requirePositiveFinite(radius, "Shadow caster radius") ** 2;
    this.activate = requireFunction(activate, "Shadow caster activation");
    this.deactivate = requireFunction(deactivate, "Shadow caster deactivation");
    this.casters = new Set();
    this.active = new Set();
    this.centerKey = null;
    this.dirty = false;
    this.activeDirty = false;
  }

  add(mesh) {
    requirePosition(mesh?.position, "Shadow caster mesh position");
    if (this.casters.has(mesh)) return false;
    this.casters.add(mesh);
    this.dirty = true;
    return true;
  }

  delete(mesh) {
    if (!this.casters.delete(mesh)) return false;
    if (this.active.delete(mesh)) {
      this.deactivate(mesh);
      this.activeDirty = true;
    }
    this.dirty = true;
    return true;
  }

  update(viewPosition) {
    const center = requirePosition(viewPosition, "Shadow caster view position");
    const nextCenterKey = chunkKey(center, this.edge);
    if (!this.dirty && nextCenterKey === this.centerKey) return false;
    const halfEdge = this.edge * 0.5;
    const next = new Set();
    for (const mesh of this.casters) {
      const position = requirePosition(mesh.position, "Shadow caster mesh position");
      const dx = position.x + halfEdge - center.x;
      const dy = position.y + halfEdge - center.y;
      const dz = position.z + halfEdge - center.z;
      if (dx * dx + dy * dy + dz * dz <= this.radiusSquared) next.add(mesh);
    }
    let activeChanged = this.activeDirty;
    for (const mesh of this.active) {
      if (!next.has(mesh)) {
        this.deactivate(mesh);
        activeChanged = true;
      }
    }
    for (const mesh of next) {
      if (!this.active.has(mesh)) {
        this.activate(mesh);
        activeChanged = true;
      }
    }
    this.active = next;
    this.centerKey = nextCenterKey;
    this.dirty = false;
    this.activeDirty = false;
    return activeChanged;
  }

  clear() {
    for (const mesh of this.active) this.deactivate(mesh);
    this.casters.clear();
    this.active.clear();
    this.centerKey = null;
    this.dirty = false;
    this.activeDirty = false;
  }

  get totalSize() {
    return this.casters.size;
  }

  get activeSize() {
    return this.active.size;
  }
}
