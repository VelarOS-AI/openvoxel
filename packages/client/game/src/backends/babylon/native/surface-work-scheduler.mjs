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

function requireInteger(value, label) {
  if (!Number.isSafeInteger(value)) {
    throw new RangeError(label + " must be an integer");
  }
  return value;
}

function columnKey(chunkX, chunkZ) {
  return chunkX + ":" + chunkZ;
}

function copyPosition(position) {
  const x = position?.x;
  const y = position?.y;
  const z = position?.z;
  if (![x, y, z].every((value) => typeof value === "number" && Number.isFinite(value))) {
    throw new TypeError("Surface work position must contain finite x, y, and z coordinates");
  }
  return {x, y, z};
}

function squaredDistance(left, right) {
  const dx = left.x - right.x;
  const dy = left.y - right.y;
  const dz = left.z - right.z;
  return dx * dx + dy * dy + dz * dz;
}

/// A latest-value, FIFO queue for work that may only cross the GPU boundary
/// from the render loop. Replacing a pending key keeps its original place and
/// completes every waiter after the newest value has been committed.
export class LatestFrameWorkQueue {
  constructor(commit) {
    this.commit = requireFunction(commit, "Frame work commit");
    this.pending = new Map();
    this.order = [];
    this.head = 0;
  }

  enqueue(key, value) {
    if (typeof key !== "string" || key.length === 0) throw new TypeError("Frame work key must be non-empty text");
    return new Promise((resolve, reject) => {
      const current = this.pending.get(key);
      if (current !== undefined) {
        current.value = value;
        current.waiters.push({resolve, reject});
        return;
      }
      const token = {};
      this.pending.set(key, {token, value, waiters: [{resolve, reject}]});
      this.order.push({key, token});
    });
  }

  drainOne() {
    while (this.head < this.order.length) {
      const {key, token} = this.order[this.head];
      this.head += 1;
      const item = this.pending.get(key);
      if (item === undefined || item.token !== token) continue;
      this.pending.delete(key);
      this.compactOrder();
      try {
        this.commit(item.value);
        for (const waiter of item.waiters) waiter.resolve(true);
      } catch (error) {
        for (const waiter of item.waiters) waiter.reject(error);
      }
      return true;
    }
    this.compactOrder();
    return false;
  }

  compactOrder() {
    if (this.head === this.order.length) {
      this.order.length = 0;
      this.head = 0;
    } else if (this.head >= 128 && this.head * 2 >= this.order.length) {
      this.order = this.order.slice(this.head);
      this.head = 0;
    }
  }

  cancel(key) {
    const item = this.pending.get(key);
    if (item === undefined) return false;
    this.pending.delete(key);
    for (const waiter of item.waiters) waiter.resolve(false);
    return true;
  }

  clear() {
    for (const item of this.pending.values()) {
      for (const waiter of item.waiters) waiter.resolve(false);
    }
    this.pending.clear();
    this.order.length = 0;
    this.head = 0;
  }

  get size() {
    return this.pending.size;
  }
}

/// Coalesces repeated vertical-section changes into one weather resample for
/// their horizontal column. Render frames provide the clock, so work cannot
/// outlive the surface or depend on browser timers. A quiet window absorbs
/// normal bursts; the maximum delay still flushes a continuously changing
/// column.
export class WeatherColumnInvalidationScheduler {
  constructor(flush, {settleMilliseconds = 32, maximumDelayMilliseconds = 64} = {}) {
    this.flushColumn = requireFunction(flush, "Weather column invalidation flush");
    this.settleMilliseconds = requireNonNegativeFinite(settleMilliseconds, "Weather column invalidation settle time");
    this.maximumDelayMilliseconds = requireNonNegativeFinite(maximumDelayMilliseconds, "Weather column invalidation maximum delay");
    if (this.maximumDelayMilliseconds < this.settleMilliseconds) {
      throw new RangeError("Weather column invalidation maximum delay cannot be shorter than its settle time");
    }
    this.elapsedMilliseconds = 0;
    this.pending = new Map();
  }

  invalidate(chunkX, chunkZ) {
    chunkX = requireInteger(chunkX, "Weather column x");
    chunkZ = requireInteger(chunkZ, "Weather column z");
    const key = columnKey(chunkX, chunkZ);
    const current = this.pending.get(key);
    if (current === undefined) {
      this.pending.set(key, {
        chunkX,
        chunkZ,
        firstInvalidatedAt: this.elapsedMilliseconds,
        lastInvalidatedAt: this.elapsedMilliseconds,
      });
    } else {
      current.lastInvalidatedAt = this.elapsedMilliseconds;
    }
  }

  advance(deltaMilliseconds) {
    this.elapsedMilliseconds += requireNonNegativeFinite(deltaMilliseconds, "Weather column invalidation frame delta");
  }

  flushReady() {
    let flushed = 0;
    for (const [key, item] of this.pending) {
      const quietMilliseconds = this.elapsedMilliseconds - item.lastInvalidatedAt;
      const ageMilliseconds = this.elapsedMilliseconds - item.firstInvalidatedAt;
      if (quietMilliseconds < this.settleMilliseconds && ageMilliseconds < this.maximumDelayMilliseconds) continue;
      this.pending.delete(key);
      this.flushColumn(item.chunkX, item.chunkZ);
      flushed += 1;
    }
    return flushed;
  }

  flush() {
    let flushed = 0;
    for (const [key, item] of this.pending) {
      this.pending.delete(key);
      this.flushColumn(item.chunkX, item.chunkZ);
      flushed += 1;
    }
    return flushed;
  }

  clear() {
    this.pending.clear();
  }

  get size() {
    return this.pending.size;
  }
}

/// Keeps expensive per-mesh translucent facet sorting bounded to one item per
/// frame. Camera movement requests another pass, but never discards an
/// unfinished pass; only nearby terrain participates because Babylon already
/// sorts distant translucent meshes against one another.
export class TranslucentSortScheduler {
  constructor({positionFor, maximumDistance, movementDistance = 1, refreshIntervalMs = 80}) {
    this.positionFor = requireFunction(positionFor, "Translucent mesh position reader");
    this.maximumDistanceSquared = requirePositiveFinite(maximumDistance, "Translucent sort maximum distance") ** 2;
    this.movementDistanceSquared = requirePositiveFinite(movementDistance, "Translucent sort movement distance") ** 2;
    this.refreshIntervalMs = requireNonNegativeFinite(refreshIntervalMs, "Translucent sort refresh interval");
    this.items = new Set();
    this.queue = [];
    this.queued = new Set();
    this.head = 0;
    this.lastPassPosition = null;
    this.elapsedMs = Number.POSITIVE_INFINITY;
    this.dirty = false;
  }

  add(item) {
    this.items.add(item);
    this.dirty = true;
  }

  delete(item) {
    const deleted = this.items.delete(item);
    if (deleted) this.queued.delete(item);
    return deleted;
  }

  clear() {
    this.items.clear();
    this.queue.length = 0;
    this.queued.clear();
    this.head = 0;
    this.lastPassPosition = null;
    this.elapsedMs = Number.POSITIVE_INFINITY;
    this.dirty = false;
  }

  refill(position) {
    const candidates = [];
    for (const item of this.items) {
      const distanceSquared = squaredDistance(copyPosition(this.positionFor(item)), position);
      if (distanceSquared <= this.maximumDistanceSquared) candidates.push({item, distanceSquared});
    }
    candidates.sort((left, right) => left.distanceSquared - right.distanceSquared);
    this.queue = candidates.map(({item}) => item);
    this.queued = new Set(this.queue);
    this.head = 0;
    this.lastPassPosition = position;
    this.elapsedMs = 0;
    this.dirty = false;
  }

  next(cameraPosition, deltaMs) {
    const position = copyPosition(cameraPosition);
    this.elapsedMs += requireNonNegativeFinite(deltaMs, "Translucent sort frame delta");
    if (this.queued.size === 0) {
      const moved = this.lastPassPosition === null
        || squaredDistance(position, this.lastPassPosition) >= this.movementDistanceSquared;
      if ((this.dirty || moved) && this.elapsedMs >= this.refreshIntervalMs) this.refill(position);
    }
    while (this.head < this.queue.length) {
      const item = this.queue[this.head];
      this.head += 1;
      if (!this.queued.delete(item) || !this.items.has(item)) continue;
      return item;
    }
    this.queue.length = 0;
    this.head = 0;
    return null;
  }

  get size() {
    return this.queued.size;
  }
}
