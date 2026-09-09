const categoryOrder = ["terrain", "vegetation", "fluid"];
const vegetationName = /(?:leaves|log_(?:side|top)|grass|flower|bush|cactus)/;
const fluidName = /^(?:water|magma|ice)(?:_|$)/;
const channelDefinitions = {
  normal: {field: "normalData", hashDigit: "4"},
  material: {field: "materialData", hashDigit: "5"},
};

function bytesFromBase64(value) {
  const binary = atob(value);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
  return bytes;
}

function base64FromBytes(bytes) {
  let binary = "";
  for (let offset = 0; offset < bytes.length; offset += 32_768) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + 32_768));
  }
  return btoa(binary);
}

function constantTextureData(width, height, layerCount, color) {
  const bytes = new Uint8Array(width * height * layerCount * 4);
  for (let offset = 0; offset < bytes.length; offset += 4) {
    bytes[offset] = color[0];
    bytes[offset + 1] = color[1];
    bytes[offset + 2] = color[2];
    bytes[offset + 3] = color[3];
  }
  return base64FromBytes(bytes);
}

/**
 * Projects one authored PBR channel into albedo for a deterministic inspection
 * view. Layout, layers, material recipes, and the production texture-array
 * upload path stay unchanged; only the in-memory test artifact is rewritten.
 */
export function materialYardChannelResourcePack(source, channel) {
  const definition = channelDefinitions[channel];
  if (definition === undefined) throw new Error(`Unknown material-yard channel ${channel}`);
  const resourcePack = structuredClone(source);
  resourcePack.resourceHash = definition.hashDigit.repeat(64);
  for (const bank of resourcePack.textureBanks) {
    for (const level of bank.levels) {
      const albedo = bytesFromBase64(level.albedoData);
      const authored = bytesFromBase64(level[definition.field]);
      if (albedo.length !== authored.length) throw new Error(`Material-yard ${channel} channel has a mismatched texture-array size`);
      for (let offset = 0; offset < albedo.length; offset += 4) {
        albedo[offset] = authored[offset];
        albedo[offset + 1] = authored[offset + 1];
        albedo[offset + 2] = authored[offset + 2];
      }
      level.albedoData = base64FromBytes(albedo);
      level.normalData = constantTextureData(level.width, level.height, bank.layerCount, [128, 128, 255, 255]);
      level.materialData = constantTextureData(level.width, level.height, bank.layerCount, [255, 255, 0, 255]);
      level.emissiveData = constantTextureData(level.width, level.height, bank.layerCount, [0, 0, 0, 255]);
    }
  }
  return resourcePack;
}

function textureCategory(texture, bankByKey) {
  const bank = bankByKey.get(texture.bankKey);
  if (bank === undefined) throw new Error(`Material-yard texture ${texture.key} references an unknown bank`);
  const name = texture.key.slice(texture.key.lastIndexOf("/") + 1);
  if (bank.role === "fluid" || bank.role === "translucent" || fluidName.test(name)) return "fluid";
  if (vegetationName.test(name)) return "vegetation";
  return "terrain";
}

function stateOwnsTexture(state, textureKey, animations) {
  if (state.pipelineKey === null || state.pipelineKey === undefined) return false;
  const textures = state.textures;
  if (textures !== null && textures !== undefined
    && [textures.top.key, textures.bottom.key, textures.side.key].includes(textureKey)) return true;
  if (state.animationKey === null || state.animationKey === undefined) return false;
  return animations.get(state.animationKey)?.frames.includes(textureKey) === true;
}

function pipelineOwner(catalog, texture, animations) {
  const owners = catalog.states
    .filter((state) => stateOwnsTexture(state, texture.key, animations))
    .sort((left, right) => left.runtimeId - right.runtimeId);
  const owner = owners[0];
  if (owner === undefined || owner.layer === null || owner.layer === undefined
    || owner.bankKey === null || owner.bankKey === undefined
    || owner.materialKey === null || owner.materialKey === undefined) {
    throw new Error(`Material-yard cannot resolve a production pipeline for ${texture.key}`);
  }
  if (owner.bankKey !== texture.bankKey) throw new Error(`Material-yard pipeline uses the wrong bank for ${texture.key}`);
  return owner;
}

function createBatch(owner) {
  const pipelineKey = `${owner.layer}|${owner.bankKey}|${owner.materialKey}|-`;
  return {
    pipelineKey,
    layer: owner.layer,
    bankKey: owner.bankKey,
    materialKey: owner.materialKey,
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
}

function pushSample(batch, x, y, z, size, layer, tint) {
  const vertexOffset = batch.positions.length / 3;
  batch.positions.push(
    x, y, z,
    x, y, z + size,
    x + size, y, z + size,
    x + size, y, z,
  );
  batch.normals.push(0, 1, 0, 0, 1, 0, 0, 1, 0, 0, 1, 0);
  batch.uvs.push(0, 0, 0, 1, 1, 1, 1, 0);
  batch.textureLayers.push(layer, layer, layer, layer);
  batch.tintRoles.push(0, 0, 0, 0);
  for (let index = 0; index < 4; index += 1) batch.colors.push(tint[0], tint[1], tint[2], 1);
  batch.indices.push(vertexOffset, vertexOffset + 1, vertexOffset + 2, vertexOffset, vertexOffset + 2, vertexOffset + 3);
  batch.quadCount += 1;
}

function finishMesh(groups, sampleCount) {
  const batches = [];
  let byteSize = 0;
  let quadCount = 0;
  for (const key of [...groups.keys()].sort()) {
    const group = groups.get(key);
    const batch = {
      pipelineKey: group.pipelineKey,
      layer: group.layer,
      bankKey: group.bankKey,
      materialKey: group.materialKey,
      animationKey: null,
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
    quadCount += batch.quadCount;
    batches.push(batch);
  }
  if (quadCount !== sampleCount) throw new Error("Material-yard sample and quad counts diverged");
  return {
    position: {x: 0, y: 0, z: 0},
    ticket: 1,
    batches,
    visibleBlocks: sampleCount,
    quadCount,
    byteSize,
  };
}

/** Builds one swatch for every physical layer while preserving logical texture grouping. */
export function createMaterialYardScene(catalog, resourcePack, channelView = "pbr") {
  const bankByKey = new Map(resourcePack.textureBanks.map((bank) => [bank.key, bank]));
  const animationByKey = new Map(resourcePack.animations.map((animation) => [animation.key, animation]));
  const materialByKey = new Map(resourcePack.materials.map((material) => [material.key, material]));
  const groups = new Map();
  const textureEvidence = [];
  const groupEvidence = [];
  const sampleLayerKeys = new Set();
  const materialUsage = new Map();
  const columns = 8;
  const sampleSize = 2.45;
  const sampleStride = 3.05;
  const groupGap = 2.4;
  let nextZ = 0;
  let sampleCount = 0;

  for (const [categoryIndex, category] of categoryOrder.entries()) {
    const textures = resourcePack.textures
      .filter((texture) => textureCategory(texture, bankByKey) === category)
      .sort((left, right) => left.key.localeCompare(right.key));
    const physicalSamples = textures.flatMap((texture) => (
      [...texture.variants]
        .sort((left, right) => left.layer - right.layer)
        .map((variant) => ({texture, variant}))
    ));
    if (physicalSamples.length === 0) throw new Error(`Material-yard category ${category} is empty`);
    const rows = Math.ceil(physicalSamples.length / columns);
    const zStart = nextZ;
    const textureSamples = new Map(textures.map((texture) => [texture.key, []]));
    for (const [index, {texture, variant}] of physicalSamples.entries()) {
      const owner = pipelineOwner(catalog, texture, animationByKey);
      const pipelineKey = `${owner.layer}|${owner.bankKey}|${owner.materialKey}|-`;
      let batch = groups.get(pipelineKey);
      if (batch === undefined) {
        batch = createBatch(owner);
        groups.set(pipelineKey, batch);
      }
      const x = (index % columns) * sampleStride;
      const y = 1 + categoryIndex * 0.42;
      const z = zStart + Math.floor(index / columns) * sampleStride;
      pushSample(batch, x, y, z, sampleSize, variant.layer, [owner.tintRed, owner.tintGreen, owner.tintBlue]);
      const layerKey = `${texture.bankKey}:${variant.layer}`;
      if (sampleLayerKeys.has(layerKey)) throw new Error(`Material-yard repeats texture-array layer ${layerKey}`);
      sampleLayerKeys.add(layerKey);
      textureSamples.get(texture.key).push({layer: variant.layer, weight: variant.weight, x, y, z});
      let usage = materialUsage.get(owner.materialKey);
      if (usage === undefined) {
        usage = {textureKeys: new Set(), bankKeys: new Set(), renderLayers: new Set(), physicalSampleCount: 0};
        materialUsage.set(owner.materialKey, usage);
      }
      usage.textureKeys.add(texture.key);
      usage.bankKeys.add(texture.bankKey);
      usage.renderLayers.add(owner.layer);
      usage.physicalSampleCount += 1;
      sampleCount += 1;
    }
    for (const texture of textures) {
      const owner = pipelineOwner(catalog, texture, animationByKey);
      textureEvidence.push({
        key: texture.key,
        category,
        bankKey: texture.bankKey,
        bankRole: bankByKey.get(texture.bankKey).role,
        materialKey: owner.materialKey,
        renderLayer: owner.layer,
        alphaCutoff: texture.alphaCutoff,
        samples: textureSamples.get(texture.key),
      });
    }
    groupEvidence.push({
      category,
      logicalTextureCount: textures.length,
      physicalSampleCount: physicalSamples.length,
      rows,
      columns,
      minimumX: 0,
      maximumX: (Math.min(columns, physicalSamples.length) - 1) * sampleStride + sampleSize,
      minimumZ: zStart,
      maximumZ: zStart + (rows - 1) * sampleStride + sampleSize,
      elevation: 1 + categoryIndex * 0.42,
    });
    nextZ = zStart + rows * sampleStride + groupGap;
  }

  const expectedLayerKeys = new Set(resourcePack.textureBanks.flatMap((bank) => (
    Array.from({length: bank.layerCount}, (_, layer) => `${bank.key}:${layer}`)
  )));
  if (sampleLayerKeys.size !== expectedLayerKeys.size
    || [...expectedLayerKeys].some((key) => !sampleLayerKeys.has(key))) {
    throw new Error("Material-yard does not cover every production texture-array layer exactly once");
  }
  if (textureEvidence.length !== resourcePack.textures.length) {
    throw new Error("Material-yard does not cover every logical production texture");
  }

  const materialEvidence = resourcePack.materials.map((definition) => {
    const usage = materialUsage.get(definition.key);
    if (usage === undefined) throw new Error(`Material-yard does not exercise production material ${definition.key}`);
    return {
      key: definition.key,
      definition,
      textureKeys: [...usage.textureKeys].sort(),
      bankKeys: [...usage.bankKeys].sort(),
      renderLayers: [...usage.renderLayers].sort(),
      physicalSampleCount: usage.physicalSampleCount,
    };
  });
  for (const materialKey of materialUsage.keys()) {
    if (!materialByKey.has(materialKey)) throw new Error(`Material-yard references unknown material ${materialKey}`);
  }

  const maximumX = Math.max(...groupEvidence.map((group) => group.maximumX));
  const maximumZ = Math.max(...groupEvidence.map((group) => group.maximumZ));
  return {
    target: {x: maximumX / 2, y: 0.2, z: maximumZ / 2},
    cameraPose: {
      alpha: -Math.PI / 4,
      beta: Math.PI / 4.15,
      radius: 51,
      target: {x: maximumX / 2, y: 1.1, z: maximumZ / 2},
    },
    meshes: [finishMesh(groups, sampleCount)],
    payload: {
      materialYard: {
        channelView,
        categoryOrder,
        sourceResourceHash: resourcePack.resourceHash,
        logicalTextureCount: textureEvidence.length,
        physicalSampleCount: sampleCount,
        textureArrayLayerCount: expectedLayerKeys.size,
        groups: groupEvidence,
        materials: materialEvidence,
        textures: textureEvidence,
      },
    },
  };
}
