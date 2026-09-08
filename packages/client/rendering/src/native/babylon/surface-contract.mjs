function requireRecord(value, label) {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new TypeError(label + " must be a record");
  }
  return value;
}

function requireFunction(value, label) {
  if (typeof value !== "function") throw new TypeError(label + " must be a function");
  return value;
}

export function requireSurfaceDependencies(value) {
  value = requireRecord(value, "Voxel surface dependencies");
  return {
    createEnvironment: requireFunction(value.createEnvironment, "Voxel surface environment factory"),
    createNavigation: requireFunction(value.createNavigation, "Voxel surface navigation factory"),
    createFlightState: requireFunction(value.createFlightState, "Voxel surface flight-state factory"),
    createSurvivalState: requireFunction(value.createSurvivalState, "Voxel surface survival-state factory"),
    stepFlight: requireFunction(value.stepFlight, "Voxel surface flight step"),
    stepSurvival: requireFunction(value.stepSurvival, "Voxel surface survival step"),
  };
}

export function requireCanvas(canvas) {
  if (!(canvas instanceof globalThis.HTMLCanvasElement)) throw new TypeError("Voxel surface requires a canvas element");
  return canvas;
}

function requireFinite(value, label) {
  if (typeof value !== "number" || !Number.isFinite(value)) throw new TypeError(label + " must be a finite number");
  return value;
}

export function requireInteger(value, minimum, maximum, label) {
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
    throw new RangeError(label + " must be an integer from " + minimum + " through " + maximum);
  }
  return value;
}

export function chunkKey(x, y, z) {
  return x + ":" + y + ":" + z;
}

function requireTypedArray(value, Constructor, label) {
  if (!(value instanceof Constructor) || value.byteOffset !== 0 || value.byteLength !== value.buffer.byteLength) {
    throw new TypeError(label + " must be a full-storage " + Constructor.name);
  }
  return value;
}

// Normalize every allocation-independent option before the adapter creates an
// engine, scene, listeners, or GPU resources. Foreign callbacks remain checked
// at their own return boundaries when they are invoked.
export function requireSurfaceOptions(candidate) {
  const options = requireRecord(candidate, "Voxel surface options");
  if (!Array.isArray(options.materials) || !Array.isArray(options.textures) || !Array.isArray(options.animations)) {
    throw new TypeError("Voxel surface resources must be lists");
  }
  for (const name of ["viewChanged", "collisionAt", "climateAt"]) {
    requireFunction(options[name], "Voxel surface " + name);
  }
  if (!["orbit", "first-person"].includes(options.navigationMode)) {
    throw new RangeError("Voxel navigation mode must be orbit or first-person");
  }
  if (!["creative-flight", "survival-walk"].includes(options.movementMode)) {
    throw new RangeError("Voxel movement mode must be creative-flight or survival-walk");
  }
  const minimumWorldY = requireInteger(options.minimumWorldY, -2147483648, 2147483647, "Minimum world y");
  const maximumWorldY = requireInteger(options.maximumWorldY, -2147483648, 2147483647, "Maximum world y");
  if (minimumWorldY >= maximumWorldY) throw new RangeError("Voxel world y bounds are inverted");
  const survivalEyeHeight = requireFinite(options.survivalEyeHeight, "Survival eye height");
  const survivalPlayerHeight = requireFinite(options.survivalPlayerHeight, "Survival player height");
  if (survivalEyeHeight <= 0 || survivalPlayerHeight <= survivalEyeHeight) {
    throw new RangeError("Survival player dimensions are invalid");
  }
  return {
    ...options,
    edge: requireInteger(options.edge, 4, 64, "Voxel Chunk edge"),
    targetX: requireFinite(options.targetX, "Camera target x"),
    targetY: requireFinite(options.targetY, "Camera target y"),
    targetZ: requireFinite(options.targetZ, "Camera target z"),
    horizontalChunkRadius: requireInteger(options.horizontalChunkRadius, 1, 8, "Horizontal render Chunk radius"),
    minimumWorldY,
    maximumWorldY,
    survivalEyeHeight,
    survivalPlayerHeight,
  };
}


const maximumChunkMeshBytes = 8 * 1024 * 1024;
const maximumChunkMeshBatches = 256;

export function validateChunkMesh(chunk, edge, materialLibrary) {
  if (typeof chunk !== "object" || chunk === null) throw new TypeError("Chunk mesh must be a record");
  const position = chunk.position;
  const x = requireInteger(position?.x, -33_554_431, 33_554_431, "Chunk x");
  const y = requireInteger(position?.y, -33_554_431, 33_554_431, "Chunk y");
  const z = requireInteger(position?.z, -33_554_431, 33_554_431, "Chunk z");
  requireInteger(chunk.ticket, 0, Number.MAX_SAFE_INTEGER, "Chunk mesh ticket");
  requireInteger(chunk.visibleBlocks, 0, edge * edge * edge, "Chunk mesh visible block count");
  const declaredQuads = requireInteger(chunk.quadCount, 0, 1_000_000, "Chunk mesh quad count");
  const declaredBytes = requireInteger(chunk.byteSize, 0, maximumChunkMeshBytes, "Chunk mesh byte size");
  if (!Array.isArray(chunk.batches)) throw new TypeError("Chunk mesh batches must be a list");
  if (chunk.batches.length > maximumChunkMeshBatches) throw new RangeError("Chunk mesh has too many material batches");

  const pipelineKeys = new Set();
  const batches = [];
  let actualBytes = 0;
  let actualQuads = 0;
  for (const [index, batch] of chunk.batches.entries()) {
    const resources = materialLibrary.resolvePipeline(batch);
    const textureBank = resources.textureBank;
    if (pipelineKeys.has(batch.pipelineKey)) throw new Error("Chunk mesh repeats material pipeline " + batch.pipelineKey);
    pipelineKeys.add(batch.pipelineKey);
    const positions = requireTypedArray(batch.positions, Float32Array, "Chunk mesh positions");
    const normals = requireTypedArray(batch.normals, Float32Array, "Chunk mesh normals");
    const uvs = requireTypedArray(batch.uvs, Float32Array, "Chunk mesh UVs");
    const textureLayers = requireTypedArray(batch.textureLayers, Float32Array, "Chunk mesh texture layers");
    const tintRoles = requireTypedArray(batch.tintRoles, Float32Array, "Chunk mesh tint roles");
    const colors = requireTypedArray(batch.colors, Float32Array, "Chunk mesh colors");
    const indices = requireTypedArray(batch.indices, Uint32Array, "Chunk mesh indices");
    const vertexCount = positions.length / 3;
    if (positions.length % 3 !== 0 || normals.length !== positions.length || uvs.length !== vertexCount * 2 || textureLayers.length !== vertexCount || tintRoles.length !== vertexCount || colors.length !== vertexCount * 4) {
      throw new Error("Chunk mesh vertex buffers have inconsistent lengths");
    }
    const quadCount = requireInteger(batch.quadCount, 0, 1_000_000, "Chunk mesh batch quad count");
    if (vertexCount !== quadCount * 4 || indices.length !== quadCount * 6 || indices.length % 3 !== 0) {
      throw new Error("Chunk mesh topology does not match its quad count");
    }
    for (const [label, values] of [["positions", positions], ["normals", normals], ["UVs", uvs], ["colors", colors]]) {
      for (const value of values) {
        if (!Number.isFinite(value)) throw new RangeError("Chunk mesh " + label + " contain a non-finite value");
      }
    }
    for (const layer of textureLayers) {
      if (!Number.isInteger(layer) || layer < 0 || layer >= textureBank.layerCount) {
        throw new RangeError("Chunk mesh texture layer is outside texture bank " + batch.bankKey);
      }
    }
    for (const role of tintRoles) requireInteger(role, 0, 4, "Chunk mesh tint role");
    const layerAlphaCutoffs = materialLibrary.textureLayerAlphaCutoffs.get(batch.bankKey);
    if (layerAlphaCutoffs === undefined) throw new Error("Chunk mesh texture bank has no layer ownership map: " + batch.bankKey);
    for (let offset = 0; offset < textureLayers.length; offset += 4) {
      const layer = textureLayers[offset];
      for (let vertexOffset = 1; vertexOffset < 4; vertexOffset += 1) {
        if (textureLayers[offset + vertexOffset] !== layer) throw new Error("Chunk mesh quad interpolates between texture array layers");
        if (tintRoles[offset + vertexOffset] !== tintRoles[offset]) throw new Error("Chunk mesh quad interpolates between climate tint roles");
      }
      if (!layerAlphaCutoffs.has(layer)) throw new Error("Chunk mesh texture layer has no resource owner: " + batch.bankKey + ":" + layer);
      if (batch.layer === "cutout" && layerAlphaCutoffs.get(layer) !== resources.materialDefinition.alphaCutoff) {
        throw new Error("Chunk mesh cutout layer was filtered for a different material alpha cutoff");
      }
      if (resources.animationBaseLayer !== null && layer !== resources.animationBaseLayer) {
        throw new Error("Animated Chunk mesh must use its animation's first texture layer");
      }
    }
    for (const vertexIndex of indices) {
      if (vertexIndex >= vertexCount) throw new RangeError("Chunk mesh index is outside its vertex buffer");
    }
    for (let quadIndex = 0; quadIndex < quadCount; quadIndex += 1) {
      const vertexOffset = quadIndex * 4;
      const indexOffset = quadIndex * 6;
      if (
        indices[indexOffset] !== vertexOffset
        || indices[indexOffset + 1] !== vertexOffset + 1
        || indices[indexOffset + 2] !== vertexOffset + 2
        || indices[indexOffset + 3] !== vertexOffset
        || indices[indexOffset + 4] !== vertexOffset + 2
        || indices[indexOffset + 5] !== vertexOffset + 3
      ) {
        throw new Error("Chunk mesh indices do not match canonical quad topology");
      }
    }
    actualBytes += positions.byteLength + normals.byteLength + uvs.byteLength + textureLayers.byteLength + tintRoles.byteLength + colors.byteLength + indices.byteLength;
    if (actualBytes > maximumChunkMeshBytes) throw new RangeError("Chunk mesh exceeds the 8 MiB upload limit");
    actualQuads += quadCount;
    batches.push({index, batch, positions, normals, uvs, textureLayers, tintRoles, colors, indices});
  }
  if (actualBytes !== declaredBytes) throw new Error("Chunk mesh byte size does not match its buffers");
  if (actualQuads !== declaredQuads) throw new Error("Chunk mesh quad count does not match its batches");
  return {key: chunkKey(x, y, z), x, y, z, batches, quads: actualQuads};
}
