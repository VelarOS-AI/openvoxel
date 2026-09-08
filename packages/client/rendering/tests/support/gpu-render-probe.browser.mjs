import {
  basePackedBlockCatalogSource,
  blockStateCatalog,
  collectBlockRenderResources,
} from "@openvoxel/blocks";
import {
  builtinClientResourcePack,
  createClientRenderCatalog,
  meshChunk,
  openVoxelRenderSurface,
} from "@openvoxel/renderer";
import {createNavigationAdapter} from "../../src/native/babylon/navigation.mjs";
import {EngineStore} from "@babylonjs/core/Engines/engineStore.js";
import {Vector3} from "@babylonjs/core/Maths/math.vector.js";
import {worldClimateAt, worldYearMilliseconds} from "@openvoxel/world";
import {probeEnvironmentTextureBlending} from "./environment-texture-probe.browser.mjs";

const chunkEdge = 16;
const packedStateByRuntimeId = new Map(basePackedBlockCatalogSource.states.map((state) => [state.runtimeId, state]));
const airRuntimeId = basePackedBlockCatalogSource.states.find((state) => state.blockKey === "openvoxel:air")?.runtimeId;
if (airRuntimeId === undefined) throw new Error("GPU probe cannot find the built-in air state");
const report = {
  ready: false,
  scene: null,
  payload: null,
  error: null,
};
globalThis.__openVoxelGpuProbe = report;
globalThis.__openVoxelGpuProbeTextureBlending = probeEnvironmentTextureBlending;

function chunkKey(position) {
  return `${position.x}:${position.y}:${position.z}`;
}

function chunkIndex(x, y, z) {
  return x + chunkEdge * (z + chunkEdge * y);
}

function paddedIndex(x, y, z) {
  const paddedEdge = chunkEdge + 2;
  return x + paddedEdge * (z + paddedEdge * y);
}

function createChunk(position) {
  return {position, blocks: new Uint32Array(chunkEdge ** 3)};
}

function setBlock(chunk, x, y, z, runtimeId) {
  chunk.blocks[chunkIndex(x, y, z)] = runtimeId;
}

function paddedBlocks(position, chunks) {
  const paddedEdge = chunkEdge + 2;
  const output = new Uint32Array(paddedEdge ** 3);
  for (let paddedY = 0; paddedY < paddedEdge; paddedY += 1) {
    const worldY = position.y * chunkEdge + paddedY - 1;
    const chunkY = Math.floor(worldY / chunkEdge);
    const localY = worldY - chunkY * chunkEdge;
    for (let paddedZ = 0; paddedZ < paddedEdge; paddedZ += 1) {
      const worldZ = position.z * chunkEdge + paddedZ - 1;
      const chunkZ = Math.floor(worldZ / chunkEdge);
      const localZ = worldZ - chunkZ * chunkEdge;
      for (let paddedX = 0; paddedX < paddedEdge; paddedX += 1) {
        const worldX = position.x * chunkEdge + paddedX - 1;
        const chunkX = Math.floor(worldX / chunkEdge);
        const localX = worldX - chunkX * chunkEdge;
        const chunk = chunks.get(`${chunkX}:${chunkY}:${chunkZ}`);
        if (chunk !== undefined) {
          output[paddedIndex(paddedX, paddedY, paddedZ)] = chunk.blocks[chunkIndex(localX, localY, localZ)];
        }
      }
    }
  }
  return output;
}

function meshChunks(chunks, states) {
  let ticket = 1;
  return [...chunks.values()].map((chunk) => {
    const mesh = meshChunk(chunk.position, chunkEdge, paddedBlocks(chunk.position, chunks), states, ticket);
    ticket += 1;
    return mesh;
  });
}

function findState(states, blockKey, predicate = () => true) {
  const state = states.find((candidate) => candidate.model !== null && candidate.model !== undefined
    && candidate.runtimeId !== airRuntimeId
    && packedStateByRuntimeId.get(candidate.runtimeId)?.blockKey === blockKey
    && predicate(candidate));
  if (state === undefined) throw new Error(`GPU probe cannot find render state ${blockKey}`);
  return state;
}

function createCatalog() {
  return createCatalogFromResourcePack(builtinClientResourcePack);
}

function createCatalogFromResourcePack(resourcePack) {
  const source = basePackedBlockCatalogSource;
  return createClientRenderCatalog({
    content: {contentHash: builtinClientResourcePack.targetContentHash, packs: []},
    schemaVersion: source.schemaVersion,
    catalogVersion: source.catalogVersion,
    stateMapHash: "0".repeat(64),
    generator: "openvoxel:gpu-render-probe",
    generatorHash: "0".repeat(64),
    generatorCatalogHash: "0".repeat(64),
    minimumWorldY: -64,
    maximumWorldY: 319,
    seaLevel: 62,
    resources: collectBlockRenderResources(blockStateCatalog()),
    blocks: source.blocks,
    componentProfiles: source.componentProfiles,
    states: source.states,
  }, resourcePack);
}

function constantTextureLevel(width, height, layerCount, color) {
  const bytes = new Uint8Array(width * height * layerCount * 4);
  for (let offset = 0; offset < bytes.length; offset += 4) {
    bytes[offset] = color[0];
    bytes[offset + 1] = color[1];
    bytes[offset + 2] = color[2];
    bytes[offset + 3] = color[3];
  }
  let binary = "";
  for (let offset = 0; offset < bytes.length; offset += 32_768) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + 32_768));
  }
  return btoa(binary);
}

function neutralizedResourcePack(channel) {
  if (channel === null) return builtinClientResourcePack;
  const channelDefinitions = {
    normal: {field: "normalData", color: [128, 128, 255, 255], hashDigit: "1"},
    material: {field: "materialData", color: [255, 255, 0, 255], hashDigit: "2"},
    emissive: {field: "emissiveData", color: [0, 0, 0, 255], hashDigit: "3"},
  };
  const definition = channelDefinitions[channel];
  if (definition === undefined) throw new Error(`Unknown GPU probe channel ${channel}`);
  const resourcePack = structuredClone(builtinClientResourcePack);
  resourcePack.resourceHash = definition.hashDigit.repeat(64);
  for (const bank of resourcePack.textureBanks) {
    for (const level of bank.levels) {
      level[definition.field] = constantTextureLevel(level.width, level.height, bank.layerCount, definition.color);
    }
  }
  return resourcePack;
}

function allStateScene(catalog) {
  const chunk = createChunk({x: 0, y: 0, z: 0});
  const visibleStates = catalog.states.filter((state) => state.model !== null && state.model !== undefined);
  const positions = [];
  for (let y = 0; y < chunkEdge; y += 1) {
    for (let z = 0; z < chunkEdge; z += 1) {
      for (let x = 0; x < chunkEdge; x += 1) {
        if ((x + y + z) % 2 === 0) positions.push({x, y, z});
      }
    }
  }
  if (positions.length < visibleStates.length) throw new Error("GPU probe Chunk cannot hold every visible state");
  for (const [index, state] of visibleStates.entries()) {
    const position = positions[index];
    setBlock(chunk, position.x, position.y, position.z, state.runtimeId);
  }
  const chunks = new Map([[chunkKey(chunk.position), chunk]]);
  const meshes = meshChunks(chunks, catalog.states);
  if (meshes[0].visibleBlocks !== visibleStates.length) throw new Error("GPU probe did not mesh every visible runtime state");
  return {
    target: {x: 8, y: 8, z: 8},
    meshes,
    payload: {
      catalogStates: catalog.states.length,
      sourceStates: basePackedBlockCatalogSource.states.length,
      visibleStates: visibleStates.length,
      meshedStates: meshes[0].visibleBlocks,
      runtimeIds: visibleStates.map((state) => state.runtimeId),
      selectedTextureLayers: new Set(meshes.flatMap((mesh) => mesh.batches.flatMap((batch) => [...batch.textureLayers]))).size,
    },
  };
}

function pushQuad(group, x, y, z, layer, tint, width = 1, depth = 1) {
  const vertexOffset = group.positions.length / 3;
  group.positions.push(
    x, y, z,
    x, y, z + depth,
    x + width, y, z + depth,
    x + width, y, z,
  );
  group.normals.push(0, 1, 0, 0, 1, 0, 0, 1, 0, 0, 1, 0);
  group.uvs.push(0, 0, 0, 1, 1, 1, 1, 0);
  group.textureLayers.push(layer, layer, layer, layer);
  group.tintRoles.push(0, 0, 0, 0);
  for (let index = 0; index < 4; index += 1) group.colors.push(tint[0], tint[1], tint[2], 1);
  group.indices.push(vertexOffset, vertexOffset + 1, vertexOffset + 2, vertexOffset, vertexOffset + 2, vertexOffset + 3);
  group.quadCount += 1;
}

function pushPanel(group, center, normal, horizontal, vertical, layer, tint, width, height) {
  const vertexOffset = group.positions.length / 3;
  const halfWidth = width / 2;
  const halfHeight = height / 2;
  const vertices = [
    [-halfWidth, -halfHeight],
    [halfWidth, -halfHeight],
    [halfWidth, halfHeight],
    [-halfWidth, halfHeight],
  ];
  for (const [horizontalOffset, verticalOffset] of vertices) {
    group.positions.push(
      center.x + horizontal.x * horizontalOffset + vertical.x * verticalOffset,
      center.y + horizontal.y * horizontalOffset + vertical.y * verticalOffset,
      center.z + horizontal.z * horizontalOffset + vertical.z * verticalOffset,
    );
    group.normals.push(normal.x, normal.y, normal.z);
  }
  group.uvs.push(0, 0, 1, 0, 1, 1, 0, 1);
  group.textureLayers.push(layer, layer, layer, layer);
  group.tintRoles.push(0, 0, 0, 0);
  for (let index = 0; index < 4; index += 1) group.colors.push(tint[0], tint[1], tint[2], 1);
  group.indices.push(vertexOffset, vertexOffset + 1, vertexOffset + 2, vertexOffset, vertexOffset + 2, vertexOffset + 3);
  group.quadCount += 1;
}

function batchGroup(state, animationKey = state.animationKey) {
  if (state.layer === null || state.layer === undefined
    || state.bankKey === null || state.bankKey === undefined
    || state.materialKey === null || state.materialKey === undefined) {
    throw new Error(`GPU probe cannot build a manual batch for runtime state ${state.runtimeId}`);
  }
  return {
    pipelineKey: `${state.layer}|${state.bankKey}|${state.materialKey}|${animationKey ?? "-"}`,
    layer: state.layer,
    bankKey: state.bankKey,
    materialKey: state.materialKey,
    animationKey,
    positions: [],
    normals: [],
    uvs: [],
    textureLayers: [],
    tintRoles: [],
    colors: [],
    indices: [],
    quadCount: 0,
  };
}

function finishManualMesh(groups, tileCount, position = {x: 0, y: 0, z: 0}) {
  const batches = [];
  let byteSize = 0;
  for (const group of groups.values()) {
    const batch = {
      pipelineKey: group.pipelineKey,
      layer: group.layer,
      bankKey: group.bankKey,
      materialKey: group.materialKey,
      animationKey: group.animationKey,
      positions: new Float32Array(group.positions),
      normals: new Float32Array(group.normals),
      uvs: new Float32Array(group.uvs),
      textureLayers: new Float32Array(group.textureLayers),
      tintRoles: new Float32Array(group.tintRoles),
      colors: new Float32Array(group.colors),
      indices: new Uint32Array(group.indices),
      quadCount: group.quadCount,
    };
    byteSize += batch.positions.byteLength + batch.normals.byteLength + batch.uvs.byteLength
      + batch.textureLayers.byteLength + batch.tintRoles.byteLength + batch.colors.byteLength + batch.indices.byteLength;
    batches.push(batch);
  }
  return {
    position,
    ticket: 1,
    batches,
    visibleBlocks: tileCount,
    quadCount: tileCount,
    byteSize,
  };
}

function textureLayerScene(catalog) {
  const laterAnimationFrames = new Set(builtinClientResourcePack.animations.flatMap((animation) => animation.frames.slice(1)));
  const animationByFirstFrame = new Map(builtinClientResourcePack.animations.map((animation) => [animation.frames[0], animation]));
  const animatedLayerKeys = new Set();
  const groups = new Map();
  const submittedLayerKeys = new Set();
  let tileIndex = 0;
  let animationPanelCount = 0;
  for (const texture of builtinClientResourcePack.textures) {
    if (laterAnimationFrames.has(texture.key)) {
      for (const variant of texture.variants) animatedLayerKeys.add(`${texture.bankKey}:${variant.layer}`);
      continue;
    }
    const state = catalog.states.find((candidate) => candidate.pipelineKey !== null
      && candidate.pipelineKey !== undefined
      && candidate.textures !== null
      && candidate.textures !== undefined
      && [candidate.textures.top.key, candidate.textures.bottom.key, candidate.textures.side.key].includes(texture.key));
    if (state === undefined) throw new Error(`GPU probe cannot find pipeline owner for ${texture.key}`);
    let group = groups.get(state.pipelineKey);
    if (group === undefined) {
      group = {
        pipelineKey: state.pipelineKey,
        layer: state.layer,
        bankKey: state.bankKey,
        materialKey: state.materialKey,
        animationKey: state.animationKey,
        positions: [],
        normals: [],
        uvs: [],
        textureLayers: [],
        tintRoles: [],
        colors: [],
        indices: [],
        quadCount: 0,
      };
      groups.set(state.pipelineKey, group);
    }
    for (const variant of texture.variants) {
      const x = (tileIndex % 8) * 2;
      const z = Math.floor(tileIndex / 8) * 2;
      pushQuad(group, x, 1, z, variant.layer, [state.tintRed, state.tintGreen, state.tintBlue]);
      submittedLayerKeys.add(`${texture.bankKey}:${variant.layer}`);
      tileIndex += 1;
    }
    if (animationByFirstFrame.has(texture.key)) {
      const variant = texture.variants[0];
      pushQuad(group, animationPanelCount * 8, 1.25, 14, variant.layer, [state.tintRed, state.tintGreen, state.tintBlue], 7, 2);
      animationPanelCount += 1;
    }
  }
  const expectedLayerKeys = new Set(builtinClientResourcePack.textureBanks.flatMap((bank) => (
    Array.from({length: bank.layerCount}, (_, layer) => `${bank.key}:${layer}`)
  )));
  const accessedLayerKeys = new Set([...submittedLayerKeys, ...animatedLayerKeys]);
  if (accessedLayerKeys.size !== expectedLayerKeys.size
    || [...expectedLayerKeys].some((key) => !accessedLayerKeys.has(key))) {
    throw new Error("GPU probe does not exercise every texture-array layer");
  }
  return {
    target: {x: 7.5, y: 0, z: 6},
    meshes: [finishManualMesh(groups, tileIndex + animationPanelCount)],
    payload: {
      expectedLayers: expectedLayerKeys.size,
      submittedLayers: submittedLayerKeys.size,
      animatedLayers: animatedLayerKeys.size,
      accessedLayers: accessedLayerKeys.size,
      animationPanels: animationPanelCount,
      channels: ["albedo", "normal", "material", "emissive"],
      animationDurations: builtinClientResourcePack.animations.map((animation) => animation.frameDurationMs),
    },
  };
}

function animationScene(catalog, animationKey) {
  const animation = catalog.animations.find((candidate) => candidate.key === animationKey);
  if (animation === undefined) throw new Error(`GPU probe cannot find animation ${animationKey}`);
  if (animation.frames.length < 2) throw new Error(`GPU probe animation must have multiple frames: ${animationKey}`);
  const firstTexture = catalog.textures.find((candidate) => candidate.key === animation.frames[0]);
  if (firstTexture === undefined || firstTexture.variants.length !== 1) {
    throw new Error(`GPU probe cannot find one animation base layer for ${animationKey}`);
  }
  const state = catalog.states.find((candidate) => candidate.model !== null
    && candidate.model !== undefined
    && candidate.pipelineKey !== null
    && candidate.pipelineKey !== undefined
    && candidate.animationKey === animationKey);
  if (state === undefined || state.layer === null || state.layer === undefined
    || state.bankKey === null || state.bankKey === undefined
    || state.materialKey === null || state.materialKey === undefined) {
    throw new Error(`GPU probe cannot find animation pipeline ${animationKey}`);
  }
  if (firstTexture.bankKey !== state.bankKey) {
    throw new Error(`GPU probe animation ${animationKey} does not use its state texture bank`);
  }
  const group = {
    pipelineKey: state.pipelineKey,
    layer: state.layer,
    bankKey: state.bankKey,
    materialKey: state.materialKey,
    animationKey,
    positions: [],
    normals: [],
    uvs: [],
    textureLayers: [],
    tintRoles: [],
    colors: [],
    indices: [],
    quadCount: 0,
  };
  for (let z = 0; z < 3; z += 1) {
    for (let x = 0; x < 3; x += 1) {
      pushQuad(
        group,
        x * 4.5,
        1,
        z * 4.5,
        firstTexture.variants[0].layer,
        [state.tintRed, state.tintGreen, state.tintBlue],
        4.25,
        4.25,
      );
    }
  }
  return {
    target: {x: 6.5, y: 0, z: 6.5},
    meshes: [finishManualMesh(new Map([[state.pipelineKey, group]]), 9)],
    payload: {
      animationKey,
      frameDurationMs: animation.frameDurationMs,
      frames: animation.frames,
      frameOffsets: animation.frames.map((key) => {
        const texture = catalog.textures.find((candidate) => candidate.key === key);
        if (texture === undefined || texture.variants.length !== 1 || texture.bankKey !== state.bankKey) {
          throw new Error(`GPU probe cannot resolve animation frame ${key}`);
        }
        return texture.variants[0].layer - firstTexture.variants[0].layer;
      }),
      baseLayer: firstTexture.variants[0].layer,
      pipelineKey: state.pipelineKey,
    },
  };
}

function pbrPanelScene(catalog, includeWeatherGround = false) {
  const textureKeys = [
    "openvoxel:texture/block/stone",
    "openvoxel:texture/block/copper_ore",
    "openvoxel:texture/block/grass_top",
    "openvoxel:texture/block/ice",
    "openvoxel:texture/block/water",
    "openvoxel:texture/block/magma",
  ];
  const groups = new Map();
  for (const [index, textureKey] of textureKeys.entries()) {
    const texture = builtinClientResourcePack.textures.find((candidate) => candidate.key === textureKey);
    if (texture === undefined) throw new Error(`GPU probe cannot find PBR texture ${textureKey}`);
    const state = catalog.states.find((candidate) => candidate.textures !== null
      && candidate.textures !== undefined
      && [candidate.textures.top.key, candidate.textures.bottom.key, candidate.textures.side.key].includes(textureKey));
    if (state === undefined || state.layer === null || state.layer === undefined
      || state.bankKey === null || state.bankKey === undefined
      || state.materialKey === null || state.materialKey === undefined) {
      throw new Error(`GPU probe cannot find PBR pipeline for ${textureKey}`);
    }
    const pipelineKey = `${state.layer}|${state.bankKey}|${state.materialKey}|-`;
    let group = groups.get(pipelineKey);
    if (group === undefined) {
      group = {
        pipelineKey,
        layer: state.layer,
        bankKey: state.bankKey,
        materialKey: state.materialKey,
        animationKey: null,
        positions: [],
        normals: [],
        uvs: [],
        textureLayers: [],
        tintRoles: [],
        colors: [],
        indices: [],
        quadCount: 0,
      };
      groups.set(pipelineKey, group);
    }
    const x = (index % 3) * 5.25;
    const z = Math.floor(index / 3) * 6;
    pushQuad(group, x, 1, z, texture.variants[0].layer, [state.tintRed, state.tintGreen, state.tintBlue], 4.5, 5.25);
  }
  let groundMeshes = [];
  if (includeWeatherGround) {
    // The high-altitude camera has terrain below its local precipitation
    // window. Give that terrain its actual owning Chunk for column-indexed
    // weather queries; impacts must remain absent until the camera descends.
    const stone = findState(catalog.states, "openvoxel:stone");
    const ground = createChunk({x: 1, y: -1, z: -1});
    for (let z = 1; z < 9; z += 1) {
      for (let x = 4; x < 12; x += 1) setBlock(ground, x, 14, z, stone.runtimeId);
    }
    groundMeshes = meshChunks(new Map([[chunkKey(ground.position), ground]]), catalog.states);
  }
  return {
    target: {x: 7.5, y: 0, z: 5.5},
    meshes: [finishManualMesh(groups, textureKeys.length), ...groundMeshes],
    payload: {
      panels: textureKeys,
      channels: ["normal", "material", "emissive"],
      weatherGroundY: includeWeatherGround ? -1 : null,
    },
  };
}

const clearEnvironmentSample = {
  worldMilliseconds: 600_000,
  samplePosition: {x: 0, y: 1, z: 0},
  timeOfDay: 0.5,
  moonPhase: 0,
  cloudiness: 0,
  precipitation: "none",
  precipitationIntensity: 0,
  windX: 0,
  windZ: 0,
  lightning: null,
};

const environmentStates = {
  day: {
    ...clearEnvironmentSample,
    timeOfDay: 0.5,
    moonPhase: 0,
  },
  night: {
    ...clearEnvironmentSample,
    worldMilliseconds: 0,
    timeOfDay: 0,
    moonPhase: 0,
  },
  clouds: {
    ...clearEnvironmentSample,
    timeOfDay: 0.5,
    cloudiness: 0.9,
    windX: 3,
    windZ: 1,
  },
  rain: {
    ...clearEnvironmentSample,
    timeOfDay: 0.5,
    cloudiness: 0.92,
    precipitation: "rain",
    precipitationIntensity: 1,
    windX: 4,
    windZ: -1,
  },
  snow: {
    ...clearEnvironmentSample,
    timeOfDay: 0.5,
    cloudiness: 0.82,
    precipitation: "snow",
    precipitationIntensity: 1,
    windX: 1.5,
    windZ: 2,
  },
  lightning: {
    ...clearEnvironmentSample,
    timeOfDay: 0.5,
    cloudiness: 0.92,
    precipitation: "rain",
    precipitationIntensity: 1,
    windX: 4,
    windZ: -1,
    lightning: {
      sequence: 73,
      position: {x: 8, y: 1, z: 6},
      intensity: 1,
      occurredAtWorldMilliseconds: clearEnvironmentSample.worldMilliseconds,
    },
  },
};

function environmentScene(catalog, preset) {
  const definition = pbrPanelScene(catalog, true);
  return {
    ...definition,
    environmentState: environmentStates[preset],
    payload: {...definition.payload, environmentPreset: preset},
  };
}

function shadowScene(catalog) {
  const chunks = new Map();
  const stone = findState(catalog.states, "openvoxel:stone");
  for (let z = 0; z < 2; z += 1) {
    for (let x = 0; x < 2; x += 1) {
      const chunk = createChunk({x, y: 0, z});
      for (let localZ = 0; localZ < chunkEdge; localZ += 1) {
        for (let localX = 0; localX < chunkEdge; localX += 1) setBlock(chunk, localX, 0, localZ, stone.runtimeId);
      }
      chunks.set(chunkKey(chunk.position), chunk);
    }
  }
  const tower = chunks.get("0:0:0");
  for (let y = 1; y <= 7; y += 1) {
    for (let z = 9; z < 12; z += 1) {
      for (let x = 10; x < 13; x += 1) setBlock(tower, x, y, z, stone.runtimeId);
    }
  }
  return {
    target: {x: 14, y: 1, z: 14},
    meshes: meshChunks(chunks, catalog.states),
    environmentState: {...clearEnvironmentSample, timeOfDay: 0.6},
    payload: {shadowOracle: true},
  };
}

function cutoutShadowScene(catalog) {
  const definition = shadowScene(catalog);
  const leaves = findState(catalog.states, "openvoxel:oak_leaves");
  const meshes = definition.meshes.map((chunk) => {
    if (!((chunk.position.x === 1 && chunk.position.z === 0) || (chunk.position.x === 0 && chunk.position.z === 1))) return chunk;
    const group = batchGroup(leaves);
    pushQuad(group, 3, 7, 3, leaves.textures.top.variants[0].layer, [1, 1, 1], 7, 7);
    const leafMesh = finishManualMesh(new Map([[group.pipelineKey, group]]), 1, chunk.position);
    return {
      ...chunk,
      batches: [...chunk.batches, ...leafMesh.batches],
      visibleBlocks: chunk.visibleBlocks + 1,
      quadCount: chunk.quadCount + 1,
      byteSize: chunk.byteSize + leafMesh.byteSize,
    };
  });
  return {...definition, meshes, payload: {...definition.payload, cutoutShadowOracle: true}};
}

function environmentViewScene(catalog, preset, lookUp) {
  const chunks = new Map();
  const grass = findState(catalog.states, "openvoxel:grass");
  const stone = findState(catalog.states, "openvoxel:stone");
  for (let z = 0; z < 2; z += 1) {
    for (let x = 0; x < 2; x += 1) {
      const chunk = createChunk({x, y: 4, z});
      for (let localZ = 0; localZ < chunkEdge; localZ += 1) {
        for (let localX = 0; localX < chunkEdge; localX += 1) setBlock(chunk, localX, 0, localZ, grass.runtimeId);
      }
      chunks.set(chunkKey(chunk.position), chunk);
    }
  }
  // A pair of solid landmarks makes the horizontal eye line and precipitation
  // depth readable without animated terrain contaminating the particle oracle.
  for (const [key, x, z] of [["0:4:0", 9, 10], ["1:4:0", 7, 11]]) {
    const chunk = chunks.get(key);
    for (let y = 1; y <= 4; y += 1) setBlock(chunk, x, y, z, stone.runtimeId);
  }
  return {
    target: {x: 16, y: 65, z: 24},
    navigationMode: "first-person",
    lookDirection: lookUp ? {x: 0, y: 1, z: -0.4} : {x: 0, y: 0, z: -1},
    meshes: meshChunks(chunks, catalog.states),
    environmentState: {...environmentStates[preset], samplePosition: {x: 16, y: 66, z: 24}, windX: 0, windZ: 0},
    payload: {environmentPreset: preset, environmentView: lookUp ? "sky" : "eye-level", weatherGroundY: 65},
  };
}

const seasonalProbeSeed = "ecology-gpu";
const seasonalTimes = {spring: 0, summer: 0.25, autumn: 0.5, winter: 0.75};

function seasonalScene(catalog) {
  const chunks = new Map();
  const grass = findState(catalog.states, "openvoxel:grass");
  const water = findState(catalog.states, "openvoxel:water");
  const trunk = findState(catalog.states, "openvoxel:oak_log");
  const leaves = findState(catalog.states, "openvoxel:oak_leaves");
  for (let z = 0; z < 2; z += 1) {
    for (let x = 0; x < 2; x += 1) {
      const chunk = createChunk({x, y: 0, z});
      for (let localZ = 0; localZ < chunkEdge; localZ += 1) {
        for (let localX = 0; localX < chunkEdge; localX += 1) {
          const pond = x === 1 && z === 0 && localX > 2 && localX < 12 && localZ < 10;
          setBlock(chunk, localX, 0, localZ, pond ? water.runtimeId : grass.runtimeId);
        }
      }
      chunks.set(chunkKey(chunk.position), chunk);
    }
  }
  for (const [key, treeX, treeZ] of [["0:0:0", 8, 9], ["1:0:1", 7, 8]]) {
    const chunk = chunks.get(key);
    for (let y = 1; y <= 5; y += 1) setBlock(chunk, treeX, y, treeZ, trunk.runtimeId);
    for (let y = 4; y <= 8; y += 1) {
      const radius = y === 8 ? 1 : 2;
      for (let dz = -radius; dz <= radius; dz += 1) {
        for (let dx = -radius; dx <= radius; dx += 1) {
          if (dx !== 0 || dz !== 0 || y > 5) setBlock(chunk, treeX + dx, y, treeZ + dz, leaves.runtimeId);
        }
      }
    }
  }
  const meshes = meshChunks(chunks, catalog.states);
  return {
    target: {x: 16, y: 1, z: 16},
    meshes,
    environmentState: {...clearEnvironmentSample, worldMilliseconds: 0},
    payload: {tintRoles: [...new Set(meshes.flatMap((mesh) => mesh.batches.flatMap((batch) => [...batch.tintRoles])))].sort()},
  };
}

function seamScene(catalog) {
  const left = createChunk({x: 0, y: 0, z: 0});
  const right = createChunk({x: 1, y: 0, z: 0});
  const stone = findState(catalog.states, "openvoxel:stone");
  const oakLeaves = findState(catalog.states, "openvoxel:oak_leaves");
  const birchLeaves = findState(catalog.states, "openvoxel:birch_leaves");
  const minimumY = 1;
  const maximumY = 5;
  const opaqueMinimumZ = 2;
  const opaqueMaximumZ = 6;
  const leafMinimumZ = 9;
  const leafMaximumZ = 13;
  for (let y = minimumY; y <= maximumY; y += 1) {
    for (let z = opaqueMinimumZ; z <= opaqueMaximumZ; z += 1) {
      setBlock(left, 15, y, z, stone.runtimeId);
      setBlock(right, 0, y, z, stone.runtimeId);
    }
    for (let z = leafMinimumZ; z <= leafMaximumZ; z += 1) {
      setBlock(left, 15, y, z, oakLeaves.runtimeId);
      setBlock(right, 0, y, z, birchLeaves.runtimeId);
    }
  }
  const chunks = new Map([
    [chunkKey(left.position), left],
    [chunkKey(right.position), right],
  ]);
  const meshes = meshChunks(chunks, catalog.states);
  const isolatedLeft = meshChunk(left.position, chunkEdge, paddedBlocks(left.position, new Map([[chunkKey(left.position), left]])), catalog.states, 10);
  const isolatedRight = meshChunk(right.position, chunkEdge, paddedBlocks(right.position, new Map([[chunkKey(right.position), right]])), catalog.states, 11);
  const isolatedMeshes = [isolatedLeft, isolatedRight];
  const seamQuads = (candidates, layer) => candidates.reduce((total, mesh) => (
    total + mesh.batches
      .filter((batch) => batch.layer === layer)
      .reduce((batchTotal, batch) => batchTotal + batch.quadCount, 0)
  ), 0);
  const opaqueIsolatedQuads = seamQuads(isolatedMeshes, "opaque");
  const opaqueJoinedQuads = seamQuads(meshes, "opaque");
  const crossTypeLeafIsolatedQuads = seamQuads(isolatedMeshes, "cutout");
  const crossTypeLeafJoinedQuads = seamQuads(meshes, "cutout");
  const opaqueCulledQuads = opaqueIsolatedQuads - opaqueJoinedQuads;
  const crossTypeLeafCulledQuads = crossTypeLeafIsolatedQuads - crossTypeLeafJoinedQuads;
  const seamHeight = maximumY - minimumY + 1;
  const expectedOpaqueCulledQuads = 2 * seamHeight * (opaqueMaximumZ - opaqueMinimumZ + 1);
  const expectedCrossTypeLeafCulledQuads = 2 * seamHeight * (leafMaximumZ - leafMinimumZ + 1);
  if (opaqueCulledQuads !== expectedOpaqueCulledQuads) throw new Error("GPU probe opaque cross-Chunk seam did not cull every shared face");
  if (crossTypeLeafCulledQuads !== expectedCrossTypeLeafCulledQuads) throw new Error("GPU probe cross-type leaf seam did not cull every shared face");
  return {
    target: {x: 16, y: 4, z: 8},
    meshes,
    payload: {
      opaque: {
        joinedQuads: opaqueJoinedQuads,
        isolatedQuads: opaqueIsolatedQuads,
        culledQuads: opaqueCulledQuads,
        expectedCulledQuads: expectedOpaqueCulledQuads,
        runtimeIds: [stone.runtimeId],
      },
      crossTypeLeaves: {
        joinedQuads: crossTypeLeafJoinedQuads,
        isolatedQuads: crossTypeLeafIsolatedQuads,
        culledQuads: crossTypeLeafCulledQuads,
        expectedCulledQuads: expectedCrossTypeLeafCulledQuads,
        runtimeIds: [oakLeaves.runtimeId, birchLeaves.runtimeId],
      },
    },
  };
}

function transparencyScene(catalog) {
  const left = createChunk({x: 0, y: 0, z: 0});
  const right = createChunk({x: 1, y: 0, z: 0});
  const sand = findState(catalog.states, "openvoxel:sand");
  const stone = findState(catalog.states, "openvoxel:stone");
  const water = findState(catalog.states, "openvoxel:water", (state) => state.level === 0 && state.falling === false);
  const magma = findState(catalog.states, "openvoxel:magma", (state) => state.level === 0 && state.falling === false);
  const ice = findState(catalog.states, "openvoxel:ice");
  for (const chunk of [left, right]) {
    for (let z = 0; z < chunkEdge; z += 1) {
      for (let x = 0; x < chunkEdge; x += 1) setBlock(chunk, x, 0, z, sand.runtimeId);
    }
  }
  for (let z = 2; z <= 12; z += 1) {
    for (let x = 10; x < chunkEdge; x += 1) setBlock(left, x, 1, z, water.runtimeId);
    for (let x = 0; x <= 5; x += 1) setBlock(right, x, 1, z, water.runtimeId);
  }
  for (let y = 1; y <= 5; y += 1) {
    for (let z = 4; z <= 7; z += 1) setBlock(left, 6, y, z, ice.runtimeId);
    for (let z = 9; z <= 12; z += 1) setBlock(right, 9, y, z, stone.runtimeId);
  }
  for (let z = 3; z <= 6; z += 1) {
    for (let x = 10; x <= 13; x += 1) setBlock(right, x, 1, z, magma.runtimeId);
  }
  const chunks = new Map([
    [chunkKey(left.position), left],
    [chunkKey(right.position), right],
  ]);
  const meshes = meshChunks(chunks, catalog.states);
  const translucentBatches = meshes.flatMap((mesh) => mesh.batches).filter((batch) => batch.layer === "translucent");
  if (translucentBatches.length < 3) throw new Error("GPU probe transparency scene lacks independent translucent pipelines");
  return {
    target: {x: 16, y: 2, z: 8},
    meshes,
    payload: {
      translucentBatches: translucentBatches.length,
      translucentQuads: translucentBatches.reduce((total, batch) => total + batch.quadCount, 0),
      materials: [...new Set(translucentBatches.map((batch) => batch.materialKey))].sort(),
    },
  };
}

function transparencyProbeBasis() {
  const alpha = -Math.PI / 4;
  const beta = Math.PI / 4.5;
  const normal = {
    x: Math.cos(alpha) * Math.sin(beta),
    y: Math.cos(beta),
    z: Math.sin(alpha) * Math.sin(beta),
  };
  const horizontal = {x: Math.SQRT1_2, y: 0, z: Math.SQRT1_2};
  const vertical = {
    x: normal.y * horizontal.z - normal.z * horizontal.y,
    y: normal.z * horizontal.x - normal.x * horizontal.z,
    z: normal.x * horizontal.y - normal.y * horizontal.x,
  };
  const radial = {x: Math.SQRT1_2, y: 0, z: -Math.SQRT1_2};
  return {normal, horizontal, vertical, radial};
}

function offsetPoint(point, direction, distance) {
  return {
    x: point.x + direction.x * distance,
    y: point.y + direction.y * distance,
    z: point.z + direction.z * distance,
  };
}

function transparencySortScene(catalog, reverseSubmission, chunkX = 0) {
  const water = findState(catalog.states, "openvoxel:water", (state) => state.level === 0 && state.falling === false);
  const group = batchGroup(water, null);
  const layer = water.textures.top.variants[0].layer;
  const basis = transparencyProbeBasis();
  const sortHorizontal = {x: -Math.SQRT1_2, y: 0, z: -Math.SQRT1_2};
  const sortVertical = {x: 0, y: 1, z: 0};
  const center = {x: 8, y: 6, z: 8};
  const panels = [
    {center: offsetPoint(center, basis.radial, -0.25), tint: [1, 0.08, 0.08]},
    {center: offsetPoint(center, basis.radial, 0.25), tint: [0.08, 1, 0.08]},
  ];
  if (reverseSubmission) panels.reverse();
  for (const panel of panels) {
    pushPanel(group, panel.center, basis.radial, sortHorizontal, sortVertical, layer, panel.tint, 11, 11);
  }
  return {
    target: {x: chunkX * chunkEdge + center.x, y: center.y - chunkEdge * 0.2, z: center.z},
    meshes: [finishManualMesh(new Map([[group.pipelineKey, group]]), panels.length, {x: chunkX, y: 0, z: 0})],
    payload: {
      chunkX,
      panelCount: panels.length,
      reverseSubmission,
      material: group.materialKey,
    },
  };
}

function transparencyDepthScene(catalog, includeHiddenPanel) {
  const stone = findState(catalog.states, "openvoxel:stone");
  const water = findState(catalog.states, "openvoxel:water", (state) => state.level === 0 && state.falling === false);
  const stoneGroup = batchGroup(stone, null);
  const waterGroup = batchGroup(water, null);
  const basis = transparencyProbeBasis();
  const center = {x: 8, y: 6, z: 8};
  pushPanel(
    stoneGroup,
    center,
    basis.normal,
    basis.horizontal,
    basis.vertical,
    stone.textures.top.variants[0].layer,
    [1, 1, 1],
    12,
    12,
  );
  const groups = new Map([[stoneGroup.pipelineKey, stoneGroup]]);
  if (includeHiddenPanel) {
    pushPanel(
      waterGroup,
      offsetPoint(center, basis.normal, -0.25),
      basis.normal,
      basis.horizontal,
      basis.vertical,
      water.textures.top.variants[0].layer,
      [0.1, 0.35, 1],
      8,
      8,
    );
    groups.set(waterGroup.pipelineKey, waterGroup);
  }
  return {
    target: {x: center.x, y: center.y - chunkEdge * 0.2, z: center.z},
    meshes: [finishManualMesh(groups, includeHiddenPanel ? 2 : 1)],
    payload: {
      hiddenPanel: includeHiddenPanel,
      opaqueQuads: stoneGroup.quadCount,
      translucentQuads: waterGroup.quadCount,
    },
  };
}

const sceneFactories = {
  states: allStateScene,
  layers: textureLayerScene,
  seams: seamScene,
  transparency: transparencyScene,
  "transparency-depth-occluded": (catalog) => transparencyDepthScene(catalog, true),
  "transparency-depth-reference": (catalog) => transparencyDepthScene(catalog, false),
  "transparency-sort-forward": (catalog) => transparencySortScene(catalog, false),
  "transparency-sort-reversed": (catalog) => transparencySortScene(catalog, true),
  "transparency-sort-translated": (catalog) => transparencySortScene(catalog, false, 2),
  pbr: pbrPanelScene,
  "pbr-normal": pbrPanelScene,
  "pbr-material": pbrPanelScene,
  "pbr-emissive": pbrPanelScene,
  day: (catalog) => environmentScene(catalog, "day"),
  night: (catalog) => environmentScene(catalog, "night"),
  clouds: (catalog) => environmentScene(catalog, "clouds"),
  rain: (catalog) => environmentScene(catalog, "rain"),
  snow: (catalog) => environmentScene(catalog, "snow"),
  lightning: (catalog) => environmentScene(catalog, "lightning"),
  shadows: shadowScene,
  "cutout-shadows": cutoutShadowScene,
  seasons: seasonalScene,
  "clouds-sky": (catalog) => environmentViewScene(catalog, "clouds", true),
  "rain-eye": (catalog) => environmentViewScene(catalog, "rain", false),
  "snow-eye": (catalog) => environmentViewScene(catalog, "snow", false),
};

let surface = null;
let activeEnvironmentState = clearEnvironmentSample;
let activeDefinition = null;
try {
  const name = new URL(globalThis.location.href).searchParams.get("scene") ?? "states";
  const animationKey = new URL(globalThis.location.href).searchParams.get("animation");
  const factory = sceneFactories[name];
  if (factory === undefined && name !== "animation") throw new Error(`Unknown GPU probe scene ${name}`);
  if (name === "animation" && animationKey === null) throw new Error("GPU probe animation scene has no animation key");
  const neutralChannel = name.startsWith("pbr-") ? name.slice(4) : null;
  const catalog = neutralChannel === null
    ? createCatalog()
    : createCatalogFromResourcePack(neutralizedResourcePack(neutralChannel));
  const definition = name === "animation"
    ? animationScene(catalog, animationKey)
    : factory(catalog);
  activeDefinition = definition;
  activeEnvironmentState = definition.environmentState ?? clearEnvironmentSample;
  const canvas = document.querySelector("[data-gpu-render-probe]");
  surface = await openVoxelRenderSurface(
    canvas,
    catalog,
    chunkEdge,
    definition.target.x,
    definition.target.y,
    definition.target.z,
    5,
    () => null,
    activeEnvironmentState,
    definition.navigationMode ?? "orbit",
    "creative-flight",
    () => null,
    0,
    255,
    seasonalProbeSeed,
  );
  if (definition.lookDirection !== undefined) {
    const camera = EngineStore.LastCreatedScene?.activeCamera;
    if (camera === null || camera === undefined) throw new Error("GPU probe has no environment camera");
    const look = definition.lookDirection;
    camera.setTarget(camera.position.add(new Vector3(look.x, look.y, look.z)));
  }
  for (const mesh of definition.meshes) surface.setChunkMesh(mesh);
  await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
  report.scene = name === "animation" ? `animation:${animationKey}` : name;
  report.payload = {
    ...definition.payload,
    neutralChannel,
    stats: surface.stats(),
    environment: surface.environmentStats(),
    resourceHash: catalog.resourceHash,
  };
  report.ready = true;
} catch (error) {
  report.error = error instanceof Error ? `${error.name}: ${error.message}\n${error.stack ?? ""}` : String(error);
  throw error;
}

globalThis.__openVoxelGpuProbeStats = () => {
  if (surface === null) throw new Error("GPU probe surface is unavailable");
  return surface.stats();
};

globalThis.__openVoxelGpuProbeAnimationCycle = () => {
  const scene = EngineStore.LastCreatedScene;
  const canvas = scene?.getEngine().getRenderingCanvas();
  const payload = activeDefinition?.payload;
  const material = scene?.getMaterialByName(`material:${payload?.pipelineKey}`);
  const plugin = material?.pluginManager?.getPlugin("OpenVoxelTextureArray");
  if (scene == null || canvas == null || plugin == null || payload?.frameOffsets === undefined) {
    throw new Error("GPU probe animation scene is unavailable");
  }
  const expectedOffsets = new Set(payload.frameOffsets);
  if (expectedOffsets.size < 2) throw new Error("GPU probe animation needs distinct texture layers");
  return new Promise((resolve, reject) => {
    const samples = [];
    const seenOffsets = new Set();
    let renderObserver = null;
    let disposeObserver = null;
    let timeout = null;
    let settled = false;
    const finish = (error = null) => {
      if (settled) return;
      settled = true;
      scene.onAfterRenderObservable.remove(renderObserver);
      scene.onDisposeObservable.remove(disposeObserver);
      canvas.removeEventListener("webglcontextlost", onContextLost);
      clearTimeout(timeout);
      if (error === null) resolve(samples);
      else reject(error);
    };
    const onContextLost = () => finish(new Error("GPU probe animation context was lost during capture"));
    disposeObserver = scene.onDisposeObservable.add(() => finish(new Error("GPU probe animation scene was released during capture")));
    canvas.addEventListener("webglcontextlost", onContextLost);
    timeout = setTimeout(() => finish(new Error(`GPU probe animation did not complete a cycle: ${JSON.stringify(samples.map(({frame, offset}) => ({frame, offset})))}`)), 15_000);
    renderObserver = scene.onAfterRenderObservable.add(() => {
      if (settled) return;
      try {
        const offset = plugin.animationLayerOffset;
        if (!expectedOffsets.has(offset)) throw new Error(`GPU probe animation has unexpected layer offset ${offset}`);
        if (samples.at(-1)?.offset === offset) return;
        // Synchronous readback after drawing pairs pixels with the material's
        // rendered offset. No screenshot delay, synthetic clock, or manual render
        // can select the phase: the production render loop drives every sample.
        samples.push({frame: scene.getFrameId(), offset, png: canvas.toDataURL("image/png")});
        seenOffsets.add(offset);
        if (seenOffsets.size === expectedOffsets.size && samples.length > expectedOffsets.size && offset === samples[0].offset) {
          finish();
        }
      } catch (error) {
        finish(error);
      }
    });
  });
};

globalThis.__openVoxelGpuProbeSetShadows = (enabled) => {
  const scene = EngineStore.LastCreatedScene;
  if (scene === null) throw new Error("GPU probe scene is unavailable");
  scene.shadowsEnabled = enabled;
};

const cutoutShadowWrappers = new Map();

globalThis.__openVoxelGpuProbeCutoutShadows = (accurate) => {
  const scene = EngineStore.LastCreatedScene;
  if (scene === null) throw new Error("GPU probe shadow scene is unavailable");
  if (accurate) {
    for (const [material, wrapper] of cutoutShadowWrappers) material.shadowDepthWrapper = wrapper;
    cutoutShadowWrappers.clear();
  } else {
    for (const material of scene.materials) {
      if (!material.shadowDepthWrapper) continue;
      cutoutShadowWrappers.set(material, material.shadowDepthWrapper);
      // Deliberately render the built-in solid-depth path as a negative oracle.
      // The visible PBR leaf material and all terrain geometry remain identical.
      material.shadowDepthWrapper = null;
    }
  }
  scene.getLightByName("openvoxel-sun-light").getShadowGenerator().getShadowMap().resetRefreshCounter();
};

globalThis.__openVoxelGpuProbeCutoutShadowStats = () => {
  const scene = EngineStore.LastCreatedScene;
  if (scene === null) throw new Error("GPU probe shadow scene is unavailable");
  const entries = scene.materials.filter((material) => material.shadowDepthWrapper).map((material) => {
    const wrapper = material.shadowDepthWrapper;
    const effects = new Set();
    let subMeshes = 0;
    for (const variants of wrapper._subMeshToDepthWrapper.mm.values()) {
      for (const entry of variants.values()) {
        subMeshes += 1;
        if (entry.mainDrawWrapper.effect) effects.add(entry.mainDrawWrapper.effect);
      }
    }
    return {meshReferences: wrapper._meshes.size, disposedMeshReferences: [...wrapper._meshes.keys()].filter((mesh) => mesh.isDisposed()).length, subMeshes, effects: effects.size};
  });
  return entries;
};

globalThis.__openVoxelGpuProbeEnvironmentView = () => {
  const scene = EngineStore.LastCreatedScene;
  const camera = scene?.activeCamera;
  const clouds = scene?.getMeshByName("openvoxel-cloud-layer");
  if (camera === null || camera === undefined || clouds === null || clouds === undefined) throw new Error("GPU probe environment view is unavailable");
  const vertices = clouds.getVerticesData("position");
  const indices = clouds.getIndices();
  if (vertices === null || indices === null) throw new Error("GPU probe cloud geometry is unavailable");
  const heights = Array.from({length: vertices.length / 3}, (_, index) => vertices[index * 3 + 1]);
  const uvs = clouds.getVerticesData("uv");
  const textureWorldPeriod = 1900 / 1.75;
  const maximumUvWorldError = Math.max(...heights.map((_, index) => Math.max(
    Math.abs(uvs[index * 2] * textureWorldPeriod - vertices[index * 3]),
    Math.abs(uvs[index * 2 + 1] * textureWorldPeriod + vertices[index * 3 + 2]),
  )));
  let maximumEdge = 0;
  for (let index = 0; index < indices.length; index += 3) {
    for (let corner = 0; corner < 3; corner += 1) {
      const from = indices[index + corner] * 3;
      const to = indices[index + (corner + 1) % 3] * 3;
      maximumEdge = Math.max(maximumEdge, Math.hypot(vertices[from] - vertices[to], vertices[from + 1] - vertices[to + 1], vertices[from + 2] - vertices[to + 2]));
    }
  }
  return {
    cameraKind: camera.getClassName(),
    directionY: camera.getForwardRay().direction.y,
    eyeY: camera.position.y,
    minimumCloudY: Math.min(...heights),
    maximumCloudY: Math.max(...heights),
    maximumCloudTriangleEdge: maximumEdge,
    maximumUvWorldError,
    cloudVertices: heights.length,
    cloudFogEnabled: clouds.applyFog && clouds.material.fogEnabled,
  };
};

globalThis.__openVoxelGpuProbeSetEnvironmentEffect = (enabled) => {
  const scene = EngineStore.LastCreatedScene;
  if (scene === null || activeDefinition === null) throw new Error("GPU probe environment view is unavailable");
  if (activeDefinition.payload.environmentView === "sky") scene.getMeshByName("openvoxel-cloud-layer").setEnabled(enabled);
  else {
    for (const name of ["openvoxel-rain", "openvoxel-snow", "openvoxel-rain-splash", "openvoxel-snow-splash"]) {
      const mesh = scene.getMeshByName(name);
      if (mesh !== null) mesh.visibility = enabled ? 1 : 0;
    }
  }
};

globalThis.__openVoxelGpuProbeEnvironmentStats = () => {
  if (surface === null) throw new Error("GPU probe surface is unavailable");
  return surface.environmentStats();
};

globalThis.__openVoxelGpuProbeSetTerrain = (enabled) => {
  if (surface === null || activeDefinition === null) throw new Error("GPU probe surface is unavailable");
  for (const mesh of activeDefinition.meshes) {
    if (enabled) surface.setChunkMesh(mesh);
    else surface.removeChunk(mesh.position.x, mesh.position.y, mesh.position.z);
  }
};

globalThis.__openVoxelGpuProbePointerLockReleaseRace = async () => {
  const canvas = document.createElement("canvas");
  canvas.tabIndex = 0;
  document.body.append(canvas);
  const pointerLockDescriptor = Object.getOwnPropertyDescriptor(document, "pointerLockElement");
  const exitPointerLockDescriptor = Object.getOwnPropertyDescriptor(document, "exitPointerLock");
  let lockedElement = null;
  let exitCalls = 0;
  let resolveRequest = null;
  let navigation = null;
  try {
    Object.defineProperty(document, "pointerLockElement", {
      configurable: true,
      get: () => lockedElement,
    });
    Object.defineProperty(document, "exitPointerLock", {
      configurable: true,
      value: () => {
        exitCalls += 1;
        lockedElement = null;
        document.dispatchEvent(new Event("pointerlockchange"));
      },
    });
    Object.defineProperty(canvas, "requestPointerLock", {
      configurable: true,
      value: () => new Promise((resolve) => {
        resolveRequest = resolve;
      }),
    });
    navigation = createNavigationAdapter({
      canvas,
      mode: "first-person",
      movementMode: "creative-flight",
      edge: 16,
      bounds: {minimumY: -64, maximumY: 320},
      initialState: {x: 0, y: 10, z: 0, velocityX: 0, velocityY: 0, velocityZ: 0},
      initialSurvivalState: {x: 0, y: 10, z: 0, velocityX: 0, velocityY: 0, velocityZ: 0, grounded: false},
      stepCreativeFlight: (state) => state,
      stepSurvivalWalk: (state) => state,
      collisionAt: () => null,
      readViewPosition: () => ({x: 0, y: 10, z: 0}),
      readViewForward: () => ({x: 0, y: 0, z: -1}),
      readHorizontalBasis: () => ({forwardX: 0, forwardZ: -1, rightX: 1, rightZ: 0}),
      applyFlightState: () => null,
      applySurvivalState: () => null,
      rotateView: () => null,
      releaseView: () => null,
      viewChanged: () => null,
    });
    canvas.dispatchEvent(new PointerEvent("pointerdown", {button: 0}));
    navigation.release();
    lockedElement = canvas;
    resolveRequest();
    await Promise.resolve();
    await Promise.resolve();
    return {
      exitCalls,
      lockReleased: lockedElement === null,
      pointerLockedAttribute: canvas.getAttribute("data-pointer-locked"),
    };
  } finally {
    navigation?.release();
    canvas.remove();
    if (pointerLockDescriptor === undefined) delete document.pointerLockElement;
    else Object.defineProperty(document, "pointerLockElement", pointerLockDescriptor);
    if (exitPointerLockDescriptor === undefined) delete document.exitPointerLock;
    else Object.defineProperty(document, "exitPointerLock", exitPointerLockDescriptor);
  }
};

globalThis.__openVoxelGpuProbeSeason = (season) => {
  if (surface === null) throw new Error("GPU probe surface is unavailable");
  if (!Object.hasOwn(seasonalTimes, season)) throw new Error(`Unknown probe season ${season}`);
  const worldMilliseconds = seasonalTimes[season] * worldYearMilliseconds;
  activeEnvironmentState = {...activeEnvironmentState, worldMilliseconds};
  surface.setEnvironment(activeEnvironmentState);
  const scene = EngineStore.LastCreatedScene;
  return {
    climate: worldClimateAt(seasonalProbeSeed, worldMilliseconds, {x: 16, y: 1, z: 16}),
    meshes: scene.meshes.filter((mesh) => mesh.name.startsWith("chunk:")).map((mesh) => mesh.uniqueId),
    stats: surface.stats(),
  };
};

globalThis.__openVoxelGpuProbeReplayLightning = () => {
  if (surface === null) throw new Error("GPU probe surface is unavailable");
  if (activeEnvironmentState.lightning === null) throw new Error("GPU probe scene has no lightning event");
  activeEnvironmentState = {
    ...activeEnvironmentState,
    lightning: {
      ...activeEnvironmentState.lightning,
      sequence: activeEnvironmentState.lightning.sequence + 1,
      occurredAtWorldMilliseconds: activeEnvironmentState.worldMilliseconds,
    },
  };
  surface.setEnvironment(activeEnvironmentState);
  return surface.environmentStats();
};

globalThis.__openVoxelGpuProbeRelease = () => {
  if (surface === null) throw new Error("GPU probe surface is unavailable");
  const statsBeforeRelease = surface.stats();
  const environmentStatsBeforeRelease = surface.environmentStats();
  surface.release();
  let statsError = null;
  let environmentStatsError = null;
  try {
    surface.stats();
  } catch (error) {
    statsError = error instanceof Error ? error.message : String(error);
  }
  try {
    surface.environmentStats();
  } catch (error) {
    environmentStatsError = error instanceof Error ? error.message : String(error);
  }
  return {
    statsBeforeRelease,
    environmentStatsBeforeRelease,
    statsRejected: statsError !== null,
    statsError,
    environmentStatsRejected: environmentStatsError !== null,
    environmentStatsError,
  };
};

globalThis.addEventListener("beforeunload", () => surface?.release(), {once: true});
