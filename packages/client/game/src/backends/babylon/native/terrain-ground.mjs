import {Ray} from "@babylonjs/core/Culling/ray.js";
import {Vector3} from "@babylonjs/core/Maths/math.vector.js";

const minimumProbeIntervalMilliseconds = 80;
const horizontalProbeDistanceSquared = 0.25;

function requireFinite(value, label) {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new TypeError(label + " must be a finite number");
  }
  return value;
}

function requirePosition(value) {
  if (typeof value !== "object" || value === null) {
    throw new TypeError("Terrain ground probe origin must be a position record");
  }
  return {
    x: requireFinite(value.x, "Terrain ground probe origin x"),
    y: requireFinite(value.y, "Terrain ground probe origin y"),
    z: requireFinite(value.z, "Terrain ground probe origin z"),
  };
}

function activeTerrainMesh(meshes, mesh) {
  return meshes.has(mesh)
    && typeof mesh.isEnabled === "function"
    && mesh.isEnabled()
    && mesh.isVisible === true;
}

function requireMeshOwnership(meshes) {
  if (typeof meshes !== "object" || meshes === null || typeof meshes.has !== "function") {
    throw new TypeError("Terrain ground probe requires terrain mesh ownership");
  }
  return meshes;
}

export function terrainColumnKey(chunkX, chunkZ) {
  if (!Number.isSafeInteger(chunkX) || !Number.isSafeInteger(chunkZ)) {
    throw new RangeError("Terrain column key requires integer Chunk coordinates");
  }
  return `${chunkX}:${chunkZ}`;
}

function defaultIntersections(ray, meshes) {
  return ray.intersectsMeshes(meshes, false);
}

function pickedGround(ray, meshes, terrainMeshes, intersections, precipitation = false) {
  const candidates = [...meshes].filter((mesh) => activeTerrainMesh(terrainMeshes, mesh)
    && (!precipitation || mesh.precipitationSurface !== "none"));
  return groundFromCandidates(ray, candidates, new Set(candidates), intersections);
}

function groundFromCandidates(ray, candidates, candidateSet, intersections) {
  if (candidates.length === 0) return null;
  const hits = intersections(ray, candidates);
  if (!Array.isArray(hits)) throw new TypeError("Terrain ground intersections must be a list");
  let highest = null;
  for (const hit of hits) {
    if (
      hit?.hit !== true
      || !candidateSet.has(hit.pickedMesh)
      || hit.pickedPoint === null
      || hit.pickedPoint === undefined
    ) continue;
    const y = requireFinite(hit.pickedPoint.y, "Terrain ground hit y");
    if (highest === null || y > highest.groundY) {
      highest = {
        groundY: y,
        skyVisible: true,
        surface: hit.pickedMesh.precipitationSurface ?? "solid",
      };
    }
  }
  return highest;
}

export function createTerrainGroundProbe(terrainMeshes, maximumDistance, options = {}) {
  terrainMeshes = requireMeshOwnership(terrainMeshes);
  maximumDistance = requireFinite(maximumDistance, "Terrain ground probe maximum distance");
  if (maximumDistance <= 0) throw new RangeError("Terrain ground probe maximum distance must be positive");
  if (typeof options !== "object" || options === null || Array.isArray(options)) {
    throw new TypeError("Terrain ground probe options must be a record");
  }
  const chunkEdge = options.chunkEdge ?? null;
  if (chunkEdge !== null && (!Number.isSafeInteger(chunkEdge) || chunkEdge < 1)) {
    throw new RangeError("Terrain ground probe Chunk edge must be a positive integer or null");
  }
  const terrainColumns = options.terrainColumns ?? null;
  if (terrainColumns !== null && (typeof terrainColumns !== "object" || typeof terrainColumns.get !== "function")) {
    throw new TypeError("Terrain ground probe columns must be a map or null");
  }
  if (terrainColumns !== null && chunkEdge === null) {
    throw new TypeError("Terrain ground probe columns require a Chunk edge");
  }
  const intersections = options.intersections ?? defaultIntersections;
  if (typeof intersections !== "function") throw new TypeError("Terrain ground probe intersections must be a function");

  const ray = new Ray(new Vector3(), new Vector3(0, -1, 0), maximumDistance);
  const columnRay = new Ray(new Vector3(), new Vector3(0, -1, 0), maximumDistance);
  let dirty = true;
  let elapsedMilliseconds = Number.POSITIVE_INFINITY;
  let sampledX = Number.NaN;
  let sampledZ = Number.NaN;
  let groundY = null;
  const columnCache = new Map();
  let columnRaycasts = 0;
  let columnCacheHits = 0;
  let candidateBuilds = 0;

  return {
    invalidate() {
      dirty = true;
      columnCache.clear();
    },

    // Ownership, visibility, geometry and surface changes are published by
    // the surface together. A different vertical Chunk invalidates the same
    // horizontal bucket, so removing a roof exposes the next actual hit.
    invalidateColumn(chunkX, chunkZ) {
      columnCache.delete(terrainColumnKey(chunkX, chunkZ));
      if (chunkEdge === null || (Math.floor(sampledX / chunkEdge) === chunkX && Math.floor(sampledZ / chunkEdge) === chunkZ)) {
        dirty = true;
      }
    },

    stats() {
      let cachedSamples = 0;
      for (const entry of columnCache.values()) cachedSamples += entry.samples.size;
      return {cachedColumns: columnCache.size, cachedSamples, columnRaycasts, columnCacheHits, candidateBuilds};
    },

    sample(candidateOrigin, deltaMilliseconds) {
      const origin = requirePosition(candidateOrigin);
      deltaMilliseconds = requireFinite(deltaMilliseconds, "Terrain ground probe frame delta");
      if (deltaMilliseconds < 0) throw new RangeError("Terrain ground probe frame delta cannot be negative");
      elapsedMilliseconds += Math.min(deltaMilliseconds, 1_000);
      const dx = origin.x - sampledX;
      const dz = origin.z - sampledZ;
      const firstSample = !Number.isFinite(dx + dz);
      const moved = !Number.isFinite(dx + dz) || dx * dx + dz * dz >= horizontalProbeDistanceSquared;
      const passedCachedGround = groundY !== null && origin.y <= groundY + 0.02;
      const refreshDue = dirty || passedCachedGround || moved;
      if (firstSample || (refreshDue && elapsedMilliseconds >= minimumProbeIntervalMilliseconds)) {
        ray.origin.set(origin.x, origin.y, origin.z);
        // The navigation probe is throttled and must also support authored test
        // meshes that can extend beyond their owning Chunk. Precipitation is the
        // high-frequency path and uses the strict column index below.
        groundY = pickedGround(ray, terrainMeshes, terrainMeshes, intersections)?.groundY ?? null;
        sampledX = origin.x;
        sampledZ = origin.z;
        elapsedMilliseconds = 0;
        dirty = false;
      }
      return groundY === null ? null : {x: origin.x, y: groundY, z: origin.z};
    },

    /// 降水列从世界顶部向下寻找真实可见表面。候选只包含同一水平 Chunk 柱
    /// 中的地形 Mesh，避免每个天气采样遍历完整驻留场景。
    sampleColumn(integerX, integerZ, originY) {
      integerX = requireFinite(integerX, "Terrain column x");
      integerZ = requireFinite(integerZ, "Terrain column z");
      originY = requireFinite(originY, "Terrain column origin y");
      if (!Number.isSafeInteger(integerX) || !Number.isSafeInteger(integerZ)) {
        throw new RangeError("Terrain column coordinates must be integers");
      }
      const sampleX = integerX + 0.5;
      const sampleZ = integerZ + 0.5;
      columnRay.origin.set(sampleX, originY, sampleZ);
      if (terrainColumns === null) return pickedGround(columnRay, terrainMeshes, terrainMeshes, intersections, true);

      const chunkX = Math.floor(integerX / chunkEdge);
      const chunkZ = Math.floor(integerZ / chunkEdge);
      const key = terrainColumnKey(chunkX, chunkZ);
      const ownedMeshes = terrainColumns.get(key);
      if (ownedMeshes === undefined) {
        // Unknown/unloaded columns never create long-lived empty buckets.
        columnCache.delete(key);
        return null;
      }
      let entry = columnCache.get(key);
      if (entry === undefined) {
        const candidates = [...ownedMeshes].filter((mesh) => activeTerrainMesh(terrainMeshes, mesh)
          && mesh.precipitationSurface !== "none");
        entry = {candidates, candidateSet: new Set(candidates), samples: new Map(), originY};
        columnCache.set(key, entry);
        candidateBuilds += 1;
      } else if (entry.originY !== originY) {
        // At most one origin variant per integer XZ cell is retained. Queries
        // from below a roof cannot reuse the world-top result above it.
        entry.samples.clear();
        entry.originY = originY;
      }
      const cell = (integerZ - chunkZ * chunkEdge) * chunkEdge + integerX - chunkX * chunkEdge;
      if (entry.samples.has(cell)) {
        columnCacheHits += 1;
        return entry.samples.get(cell);
      }
      if (entry.candidates.length > 0) columnRaycasts += 1;
      const sample = groundFromCandidates(columnRay, entry.candidates, entry.candidateSet, intersections);
      const result = sample === null ? null : Object.freeze(sample);
      entry.samples.set(cell, result);
      return result;
    },
  };
}
