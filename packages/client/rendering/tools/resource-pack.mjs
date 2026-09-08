import {readFile} from "node:fs/promises";
import {dirname, resolve} from "node:path";
import {fileURLToPath} from "node:url";
import sharp from "sharp";
import {loadResourceManifest} from "./resource-manifest.mjs";
import {
  compareText,
  requireBoolean,
  requireInteger,
  requireList,
  requireNumber,
  requireRecord,
  requireText,
  resolveInside,
  sha256,
  stableJson,
  uniqueByKey,
} from "./resource-pack-values.mjs";
import {buildTextureArray} from "./texture-array.mjs";

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const dataRoot = resolve(packageRoot, "data");
const manifestPath = resolve(dataRoot, "resource-pack.yml");
const blockCatalogPath = fileURLToPath(import.meta.resolve("@openvoxel/blocks/block-catalog-data"));
const generatorCatalogPath = fileURLToPath(import.meta.resolve("@openvoxel/world-generation/world-generator-catalog-data"));
const bankRoles = ["opaque", "cutout", "translucent", "fluid"];
const textureChannels = ["albedo", "normal", "material", "emissive"];
const maximumTextureBankChannelBytes = 16 * 1024 * 1024;
const maximumClientTextureResidentBytes = 128 * 1024 * 1024;
const maximumEnvironmentImageSize = 2048;

function requiredResources(blockCatalog) {
  const resources = {
    models: new Set(),
    materials: new Set(),
    textures: new Set(),
    tints: new Set(),
    animations: new Set(),
  };
  for (const profile of blockCatalog.catalog.componentProfiles) {
    const render = profile.render;
    if (render.model == null) continue;
    resources.models.add(render.model);
    resources.materials.add(render.material);
    if (render.tint != null) resources.tints.add(render.tint);
    if (render.animation != null) resources.animations.add(render.animation);
    for (const key of textureKeys(render)) resources.textures.add(key);
  }
  return resources;
}

function textureKeys(render) {
  if (render.textures == null) return [];
  return [...new Set([
    render.textures.all,
    render.textures.top,
    render.textures.bottom,
    render.textures.side,
  ].filter((key) => key != null))];
}

function bankRole(render, modelByKey) {
  const model = modelByKey.get(render.model);
  if (model == null) throw new Error(`Rendered component profile references unknown model ${render.model}`);
  if (model.kind === "fluid") return "fluid";
  if (bankRoles.includes(render.layer)) return render.layer;
  throw new Error(`Rendered component profile has unsupported layer ${render.layer}`);
}

export function planTextureBanks(blockCatalog, animations, materials, models) {
  const animationByKey = new Map(animations.map((animation) => [animation.key, animation]));
  const materialByKey = new Map(materials.map((material) => [material.key, material]));
  const modelByKey = new Map(models.map((model) => [model.key, model]));
  const assignments = new Map();
  const textureAlphaCutoffs = new Map();
  const assign = (key, role, alphaCutoff) => {
    const current = assignments.get(key);
    if (current != null && current !== role) {
      throw new Error(`Texture ${key} is used by both ${current} and ${role} banks; duplicate it under distinct logical keys`);
    }
    assignments.set(key, role);
    if (role !== "cutout") return;
    const currentCutoff = textureAlphaCutoffs.get(key);
    if (currentCutoff != null && currentCutoff !== alphaCutoff) {
      throw new Error(`Cutout texture ${key} is used with both ${currentCutoff} and ${alphaCutoff} alpha cutoffs; duplicate it under distinct logical keys`);
    }
    textureAlphaCutoffs.set(key, alphaCutoff);
  };
  for (const profile of blockCatalog.catalog.componentProfiles) {
    const render = profile.render;
    if (render.model == null) continue;
    const role = bankRole(render, modelByKey);
    let alphaCutoff = null;
    if (role === "cutout") {
      const material = materialByKey.get(render.material);
      if (material == null) throw new Error(`Cutout component profile references unknown material ${render.material}`);
      alphaCutoff = material.alphaCutoff;
    }
    for (const key of textureKeys(render)) assign(key, role, alphaCutoff);
    if (render.animation != null) {
      const animation = animationByKey.get(render.animation);
      if (animation == null) throw new Error(`Rendered component profile references unknown animation ${render.animation}`);
      for (const frame of animation.frames) assign(frame, role, alphaCutoff);
    }
  }
  return {assignments, textureAlphaCutoffs};
}

function requireCoverage(required, declared, label) {
  for (const key of [...required].sort()) {
    if (!declared.has(key)) throw new Error(`Client resource pack is missing ${label} ${key}`);
  }
}

function requireNoOrphans(required, declared, label) {
  for (const key of [...declared].sort()) {
    if (!required.has(key)) throw new Error(`Client resource pack declares unused ${label} ${key}`);
  }
}

function worldContentHash(blockCatalog, generatorCatalog) {
  return sha256([stableJson({
    blockCatalogHash: blockCatalog.contentHash,
    packs: [],
    worldGeneratorCatalogHash: generatorCatalog.contentHash,
  })]);
}

function dataUrl(type, bytes) {
  return `data:${type};base64,${bytes.toString("base64")}`;
}

async function loadEnvironmentImage(root, file, label, shape) {
  const bytes = await readFile(resolveInside(root, file, label));
  const metadata = await sharp(bytes).metadata();
  if (metadata.format !== "webp" || metadata.width == null || metadata.height == null) {
    throw new Error(`${label} must be a WebP image`);
  }
  if (metadata.width > maximumEnvironmentImageSize || metadata.height > maximumEnvironmentImageSize) {
    throw new RangeError(`${label} must not exceed ${maximumEnvironmentImageSize} pixels on either axis`);
  }
  if (shape === "square" && metadata.width !== metadata.height) {
    throw new RangeError(`${label} must be square`);
  }
  if (shape === "portrait" && metadata.height < metadata.width) {
    throw new RangeError(`${label} height must be at least its width`);
  }
  return {path: file, bytes, width: metadata.width, height: metadata.height};
}

function environmentTextureMemory(sourceImages) {
  const decodedRgbaBytes = sourceImages.reduce(
    (total, image) => total + image.width * image.height * 4,
    0,
  );
  const encodedHeapBytes = sourceImages.reduce(
    (total, image) => total + Math.floor((image.bytes.byteLength + 2) / 3) * 4 * 2,
    0,
  );
  return {
    imageCount: sourceImages.length,
    decodedRgbaBytes,
    gpuBytes: decodedRgbaBytes,
    encodedHeapBytes,
    residentBytes: decodedRgbaBytes + encodedHeapBytes,
  };
}

export function requireClientTextureMemoryBudget(bankMemories, environmentMemory) {
  const bankGpuBytes = bankMemories.reduce((total, memory) => total + memory.gpuBytes, 0);
  const bankResidentBytes = bankMemories.reduce((total, memory) => total + memory.residentBytes, 0);
  const gpuBytes = bankGpuBytes + environmentMemory.gpuBytes;
  const estimatedResidentBytes = bankResidentBytes + environmentMemory.residentBytes;
  if (estimatedResidentBytes > maximumClientTextureResidentBytes) {
    throw new RangeError(`Client resource pack needs an estimated ${estimatedResidentBytes} resident texture bytes; the limit is ${maximumClientTextureResidentBytes}`);
  }
  return {
    maximumResidentBytes: maximumClientTextureResidentBytes,
    gpuBytes,
    estimatedResidentBytes,
  };
}

export async function loadEnvironmentResources(root, environment) {
  const moonKeys = environment.sky.moons.map((_file, index) => `moon-${index}`);
  const definitions = [
    {key: "sun", file: environment.sky.sun, label: "Environment sky sun", shape: "square"},
    {key: "glow", file: environment.sky.glow, label: "Environment sky glow", shape: "square"},
    {key: "star", file: environment.sky.star, label: "Environment sky star", shape: "square"},
    ...environment.sky.moons.map((file, index) => ({
      key: moonKeys[index],
      file,
      label: `Environment sky moon ${index + 1}`,
      shape: "square",
    })),
    {key: "clouds", file: environment.clouds.texture, label: "Environment clouds texture", shape: "square"},
    {key: "rain", file: environment.precipitation.rain, label: "Environment precipitation rain", shape: "portrait"},
    {key: "rain-splash", file: environment.precipitation.rainSplash, label: "Environment precipitation rain splash", shape: "square"},
    {key: "snow", file: environment.precipitation.snow, label: "Environment precipitation snow", shape: "square"},
  ];
  const sourceImages = await Promise.all(definitions.map(async ({file, label, shape}) => (
    loadEnvironmentImage(root, file, label, shape)
  )));
  const memory = environmentTextureMemory(sourceImages);
  requireClientTextureMemoryBudget([], memory);
  const imageByKey = new Map(definitions.map(({key}, index) => [key, sourceImages[index]]));
  const imageUrl = (key) => dataUrl("image/webp", imageByKey.get(key).bytes);
  return {
    artifact: {
      sky: {
        sunDataUrl: imageUrl("sun"),
        glowDataUrl: imageUrl("glow"),
        starDataUrl: imageUrl("star"),
        moonDataUrls: moonKeys.map(imageUrl),
      },
      clouds: {textureDataUrl: imageUrl("clouds")},
      precipitation: {
        rainDataUrl: imageUrl("rain"),
        rainSplashDataUrl: imageUrl("rain-splash"),
        snowDataUrl: imageUrl("snow"),
      },
    },
    sourceImages,
    memory,
  };
}

function base64(bytes) {
  return bytes.toString("base64");
}

function textureVariantCount(textures) {
  return textures.reduce((total, texture) => total + 1 + (texture.variants?.length ?? 0), 0);
}

function textureArrayLevelDimensions(size, mipmaps) {
  const levels = [{width: size, height: size}];
  while (mipmaps && (levels.at(-1).width > 1 || levels.at(-1).height > 1)) {
    const previous = levels.at(-1);
    levels.push({
      width: Math.max(1, Math.floor(previous.width / 2)),
      height: Math.max(1, Math.floor(previous.height / 2)),
    });
  }
  return levels;
}

function textureArrayMemory(levels, layerCount) {
  const levelChannelBytes = levels.map(({width, height}) => width * height * layerCount * 4);
  const channelBytes = levelChannelBytes.reduce((total, bytes) => total + bytes, 0);
  const gpuBytes = channelBytes * textureChannels.length;
  const cpuRestoreBytes = gpuBytes;
  const encodedCharacters = levelChannelBytes.reduce(
    (total, bytes) => total + Math.floor((bytes + 2) / 3) * 4 * textureChannels.length,
    0,
  );
  const encodedHeapBytes = encodedCharacters * 2;
  return {
    channelBytes,
    gpuBytes,
    cpuRestoreBytes,
    encodedHeapBytes,
    residentBytes: gpuBytes + cpuRestoreBytes + encodedHeapBytes,
  };
}

/**
 * Builds the content identity for an authored resource pack and its generated outputs.
 * YAML object key order and unordered catalog/source enumeration do not affect the result;
 * semantically ordered variant, layer, and animation lists remain significant.
 */
export function computeResourceHash({manifest, catalogs, sourceImages, bankAssignments, payload, bankChannels}) {
  const normalizedManifest = manifest.textureCatalogs == null
    ? manifest
    : {...manifest, textureCatalogs: [...manifest.textureCatalogs].sort(compareText)};
  const normalizedCatalogs = catalogs
    .map(({file, document}) => ({
      file,
      document: document.textures == null
        ? document
        : {...document, textures: [...document.textures].sort((left, right) => compareText(left.key, right.key))},
    }))
    .sort((left, right) => compareText(left.file, right.file));
  const normalizedSourceImages = sourceImages
    .map(({path, bytes}) => ({path, sha256: sha256([bytes])}))
    .sort((left, right) => compareText(left.path, right.path));
  const normalizedAssignments = [...bankAssignments.entries()]
    .map(([texture, role]) => ({texture, role}))
    .sort((left, right) => compareText(left.texture, right.texture));
  const normalizedBankChannels = bankChannels
    .flatMap((bank) => bank.levels.flatMap((level, mipLevel) => textureChannels.map((channel) => ({
      path: `texture-arrays/${bank.role}-mip-${mipLevel}-${channel}.rgba8`,
      sha256: sha256([level[`${channel}Bytes`]]),
    }))))
    .sort((left, right) => compareText(left.path, right.path));
  return sha256([stableJson({
    identityVersion: 2,
    source: {
      manifest: normalizedManifest,
      catalogs: normalizedCatalogs,
      images: normalizedSourceImages,
    },
    bankAssignments: normalizedAssignments,
    generated: {
      artifactPayload: payload,
      textureBankChannels: normalizedBankChannels,
    },
  })]);
}

export async function buildResourcePack() {
  const [source, blockText, generatorText] = await Promise.all([
    loadResourceManifest(dataRoot, manifestPath),
    readFile(blockCatalogPath, "utf8"),
    readFile(generatorCatalogPath, "utf8"),
  ]);
  const {manifest, owner, environment} = source;
  const blockCatalog = JSON.parse(blockText);
  const generatorCatalog = JSON.parse(generatorText);
  const required = requiredResources(blockCatalog);

  const declaredModels = uniqueByKey(manifest.models, owner, "models");
  const declaredMaterials = uniqueByKey(manifest.materials, owner, "materials");
  const declaredTextures = uniqueByKey(source.textures, owner, "textures");
  const declaredTints = uniqueByKey(manifest.tints, owner, "tints");
  const declaredAnimations = uniqueByKey(manifest.animations, owner, "animations");

  const models = requireList(manifest.models, "models").map((raw) => {
    const entry = requireRecord(raw, "model entry");
    return {key: entry.key, kind: requireText(entry.kind, `model ${entry.key} kind`)};
  });
  const materials = requireList(manifest.materials, "materials").map((raw) => {
    const entry = requireRecord(raw, "material entry");
    return {
      key: entry.key,
      precipitationSurface: entry.precipitationSurface,
      alpha: requireNumber(entry.alpha, 0, 1, `material ${entry.key} alpha`),
      alphaCutoff: requireNumber(entry.alphaCutoff, 0, 1, `material ${entry.key} alphaCutoff`),
      doubleSided: requireBoolean(entry.doubleSided, `material ${entry.key} doubleSided`),
      castsShadows: requireBoolean(entry.castsShadows, `material ${entry.key} castsShadows`),
      environmentIntensity: requireNumber(entry.environmentIntensity, 0, 4, `material ${entry.key} environmentIntensity`),
      clearCoat: requireNumber(entry.clearCoat, 0, 1, `material ${entry.key} clearCoat`),
      clearCoatRoughness: requireNumber(entry.clearCoatRoughness, 0, 1, `material ${entry.key} clearCoatRoughness`),
      unlit: requireBoolean(entry.unlit, `material ${entry.key} unlit`),
    };
  });
  const tints = requireList(manifest.tints, "tints").map((raw) => {
    const entry = requireRecord(raw, "tint entry");
    if (!["none", "grass", "foliage", "water"].includes(entry.climate)) throw new Error(`Tint ${entry.key} has an invalid climate policy`);
    if (!["all", "grass_cap"].includes(entry.coverage)) throw new Error(`Tint ${entry.key} has an invalid coverage policy`);
    if (entry.coverage === "grass_cap" && entry.climate !== "grass") throw new Error(`Tint ${entry.key} grass-cap coverage requires grass climate`);
    return {
      key: entry.key,
      climate: entry.climate,
      coverage: entry.coverage,
      red: requireNumber(entry.red, 0, 1, `tint ${entry.key} red`),
      green: requireNumber(entry.green, 0, 1, `tint ${entry.key} green`),
      blue: requireNumber(entry.blue, 0, 1, `tint ${entry.key} blue`),
    };
  });
  const animations = requireList(manifest.animations, "animations").map((raw) => {
    const entry = requireRecord(raw, "animation entry");
    const frames = requireList(entry.frames, `animation ${entry.key} frames`)
      .map((frame) => requireText(frame, `animation ${entry.key} frame`));
    if (frames.length < 2) throw new Error(`Animation ${entry.key} needs at least two frames`);
    if (new Set(frames).size !== frames.length) throw new Error(`Animation ${entry.key} repeats a frame`);
    for (const frame of frames) {
      if (!declaredTextures.has(frame)) throw new Error(`Animation ${entry.key} references unknown texture ${frame}`);
    }
    return {
      key: entry.key,
      frameDurationMs: requireInteger(entry.frameDurationMs, 16, 60_000, `animation ${entry.key} frameDurationMs`),
      frames,
    };
  });

  for (const animation of animations) {
    if (required.animations.has(animation.key)) {
      for (const frame of animation.frames) required.textures.add(frame);
    }
  }
  requireCoverage(required.models, declaredModels, "model");
  requireCoverage(required.materials, declaredMaterials, "material");
  requireCoverage(required.textures, declaredTextures, "texture");
  requireCoverage(required.tints, declaredTints, "tint");
  requireCoverage(required.animations, declaredAnimations, "animation");
  requireNoOrphans(required.models, declaredModels, "model");
  requireNoOrphans(required.materials, declaredMaterials, "material");
  requireNoOrphans(required.textures, declaredTextures, "texture");
  requireNoOrphans(required.tints, declaredTints, "tint");
  requireNoOrphans(required.animations, declaredAnimations, "animation");

  const environmentResources = await loadEnvironmentResources(dataRoot, environment);

  const {assignments, textureAlphaCutoffs} = planTextureBanks(blockCatalog, animations, materials, models);
  const plannedLevels = textureArrayLevelDimensions(source.packing.tileSize, source.packing.mipmaps);
  const plannedBankMemories = bankRoles.map((role) => {
    const sources = source.textures.filter((texture) => assignments.get(texture.key) === role);
    const memory = textureArrayMemory(plannedLevels, textureVariantCount(sources));
    if (memory.channelBytes > maximumTextureBankChannelBytes) {
      throw new RangeError(`Texture bank ${role} needs ${memory.channelBytes} bytes per channel; the limit is ${maximumTextureBankChannelBytes}`);
    }
    return memory;
  });
  requireClientTextureMemoryBudget(plannedBankMemories, environmentResources.memory);
  const bankArtifacts = [];
  const bankChannels = [];
  const textures = [];
  const bankAudits = [];
  for (const role of bankRoles) {
    const bankSources = source.textures.filter((texture) => assignments.get(texture.key) === role);
    if (bankSources.length === 0) continue;
    const built = await buildTextureArray({
      dataRoot,
      array: source.packing,
      textureSources: bankSources,
      surfaceProfiles: source.surfaceProfiles,
      role,
      textureAlphaCutoffs,
    });
    const key = `${owner}:texture-bank/${role}`;
    bankArtifacts.push({
      key,
      role,
      storage: "texture_2d_array",
      layerCount: built.layerCount,
      levels: built.levels.map((level) => ({
        width: level.width,
        height: level.height,
        albedoData: base64(level.albedoBytes),
        normalData: base64(level.normalBytes),
        materialData: base64(level.materialBytes),
        emissiveData: base64(level.emissiveBytes),
      })),
    });
    textures.push(...built.textures.map((texture) => ({...texture, bankKey: key})));
    bankChannels.push({
      role,
      levels: built.levels,
    });
    const memory = textureArrayMemory(built.levels, built.layerCount);
    bankAudits.push({key, role, storage: "texture_2d_array", ...built.audit, memory});
  }
  if (textures.length !== source.textures.length) throw new Error("Some client textures were not assigned to a render bank");
  textures.sort((left, right) => compareText(left.key, right.key));

  const environmentSourceImages = new Map(environmentResources.sourceImages.map((entry) => [entry.path, entry]));
  const sourceImageEntries = await Promise.all(source.referencedImageFiles.map(async (file) => (
    environmentSourceImages.get(file) ?? {
      path: file,
      bytes: await readFile(resolveInside(dataRoot, file, `resource image ${file}`)),
    }
  )));
  const targetContentHash = worldContentHash(blockCatalog, generatorCatalog);
  const payload = {
    artifactVersion: 8,
    formatVersion: 8,
    owner,
    targetContentHash,
    textureBanks: bankArtifacts,
    environment: environmentResources.artifact,
    models,
    materials,
    textures,
    tints,
    animations,
  };
  const resourceHash = computeResourceHash({
    manifest,
    catalogs: source.catalogs,
    sourceImages: sourceImageEntries,
    bankAssignments: assignments,
    payload,
    bankChannels,
  });
  const artifact = {...payload, resourceHash};
  const sourceImages = await Promise.all(sourceImageEntries.map(async ({path, bytes, width, height}) => {
    if (width != null && height != null) return {path, width, height, sha256: sha256([bytes])};
    const metadata = await sharp(bytes).metadata();
    return {path, width: metadata.width, height: metadata.height, sha256: sha256([bytes])};
  }));
  const categories = Object.fromEntries(source.catalogs.map(({category, textures: entries}) => [category, entries.length]));
  const memory = requireClientTextureMemoryBudget(
    bankAudits.map((bank) => bank.memory),
    environmentResources.memory,
  );
  const audit = {
    formatVersion: 4,
    resourceHash,
    sourceImages,
    unusedFiles: source.unusedFiles,
    textureCount: textures.length,
    variantCount: textures.reduce((total, texture) => total + texture.variants.length, 0),
    categories,
    banks: bankAudits,
    environment: environmentResources.memory,
    maximumResidentBytes: memory.maximumResidentBytes,
    gpuBytes: memory.gpuBytes,
    estimatedResidentBytes: memory.estimatedResidentBytes,
  };
  return {
    artifact,
    artifactText: `${JSON.stringify(artifact, null, 2)}\n`,
    audit,
    auditText: `${JSON.stringify(audit, null, 2)}\n`,
    bankChannels,
  };
}

export const paths = {
  packageRoot,
  artifact: resolve(packageRoot, "generated/client-resource-pack.json"),
  audit: resolve(packageRoot, "generated/resource-audit.json"),
  bankRoot: resolve(packageRoot, "generated/texture-banks"),
};
