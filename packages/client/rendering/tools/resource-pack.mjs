import {readFile} from "node:fs/promises";
import {dirname, resolve} from "node:path";
import {fileURLToPath} from "node:url";
import sharp from "sharp";
import {loadResourceManifest} from "./resource-manifest.mjs";
import {
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
import {buildTextureAtlas} from "./texture-atlas.mjs";

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const dataRoot = resolve(packageRoot, "data");
const manifestPath = resolve(dataRoot, "resource-pack.yml");
const blockCatalogPath = fileURLToPath(import.meta.resolve("@openvoxel/blocks/block-catalog-data"));
const generatorCatalogPath = fileURLToPath(import.meta.resolve("@openvoxel/world-generation/world-generator-catalog-data"));
const bankRoles = ["opaque", "cutout", "translucent", "fluid"];
const textureChannels = ["albedo", "normal", "material", "emissive"];

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

function bankRole(render) {
  if (render.model === "openvoxel:model/block/fluid") return "fluid";
  if (bankRoles.includes(render.layer)) return render.layer;
  throw new Error(`Rendered component profile has unsupported layer ${render.layer}`);
}

function textureBankAssignments(blockCatalog, animations) {
  const animationByKey = new Map(animations.map((animation) => [animation.key, animation]));
  const assignments = new Map();
  const assign = (key, role) => {
    const current = assignments.get(key);
    if (current != null && current !== role) {
      throw new Error(`Texture ${key} is used by both ${current} and ${role} banks; duplicate it under distinct logical keys`);
    }
    assignments.set(key, role);
  };
  for (const profile of blockCatalog.catalog.componentProfiles) {
    const render = profile.render;
    if (render.model == null) continue;
    const role = bankRole(render);
    for (const key of textureKeys(render)) assign(key, role);
    if (render.animation != null) {
      const animation = animationByKey.get(render.animation);
      if (animation == null) throw new Error(`Rendered component profile references unknown animation ${render.animation}`);
      for (const frame of animation.frames) assign(frame, role);
    }
  }
  return assignments;
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

function variantCount(textures) {
  return textures.reduce((total, texture) => total + 1 + (texture.variants?.length ?? 0), 0);
}

function compareText(left, right) {
  if (left < right) return -1;
  if (left > right) return 1;
  return 0;
}

/**
 * Builds the content identity for an authored resource pack and its generated outputs.
 * YAML object key order and source-file or mapping enumeration order do not affect the
 * result; authored list order remains significant because it can change layout or animation.
 */
export function computeResourceHash({manifest, catalogs, sourceImages, bankAssignments, payload, bankImages}) {
  const normalizedCatalogs = catalogs
    .map(({file, document}) => ({file, document}))
    .sort((left, right) => compareText(left.file, right.file));
  const normalizedSourceImages = sourceImages
    .map(({path, bytes}) => ({path, sha256: sha256([bytes])}))
    .sort((left, right) => compareText(left.path, right.path));
  const normalizedAssignments = [...bankAssignments.entries()]
    .map(([texture, role]) => ({texture, role}))
    .sort((left, right) => compareText(left.texture, right.texture));
  const normalizedBankImages = bankImages
    .flatMap((bank) => textureChannels.map((channel) => ({
      path: `texture-banks/${bank.role}-${channel}.png`,
      sha256: sha256([bank[`${channel}Bytes`]]),
    })))
    .sort((left, right) => compareText(left.path, right.path));
  return sha256([stableJson({
    identityVersion: 1,
    source: {
      manifest,
      catalogs: normalizedCatalogs,
      images: normalizedSourceImages,
    },
    bankAssignments: normalizedAssignments,
    generated: {
      artifactPayload: payload,
      textureBankImages: normalizedBankImages,
    },
  })]);
}

export async function buildResourcePack() {
  const [source, blockText, generatorText] = await Promise.all([
    loadResourceManifest(dataRoot, manifestPath),
    readFile(blockCatalogPath, "utf8"),
    readFile(generatorCatalogPath, "utf8"),
  ]);
  const {manifest, owner} = source;
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
    return {
      key: entry.key,
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

  const environmentSource = requireRecord(manifest.environment, "environment");
  const cloudsFile = requireText(environmentSource.clouds, "environment clouds");
  const cloudsBytes = await readFile(resolveInside(dataRoot, cloudsFile, "environment clouds"));
  const cloudsMetadata = await sharp(cloudsBytes).metadata();
  if (cloudsMetadata.format !== "webp" || cloudsMetadata.width == null || cloudsMetadata.height == null
    || cloudsMetadata.width > 2048 || cloudsMetadata.height > 2048) {
    throw new Error("Environment clouds must be a WebP image no larger than 2048x2048");
  }

  const assignments = textureBankAssignments(blockCatalog, animations);
  const bankArtifacts = [];
  const bankImages = [];
  const textures = [];
  const bankAudits = [];
  for (const role of bankRoles) {
    const bankSources = source.textures.filter((texture) => assignments.get(texture.key) === role);
    if (bankSources.length === 0) continue;
    const columns = Math.min(source.packing.columns, Math.ceil(Math.sqrt(variantCount(bankSources))));
    const built = await buildTextureAtlas({
      dataRoot,
      atlas: {...source.packing, columns},
      textureSources: bankSources,
      surfaceProfiles: source.surfaceProfiles,
    });
    const key = `${owner}:texture-bank/${role}`;
    bankArtifacts.push({
      key,
      role,
      storage: "atlas",
      width: built.width,
      height: built.height,
      mipmaps: built.mipmaps,
      albedoDataUrl: dataUrl("image/png", built.albedoBytes),
      normalDataUrl: dataUrl("image/png", built.normalBytes),
      materialDataUrl: dataUrl("image/png", built.materialBytes),
      emissiveDataUrl: dataUrl("image/png", built.emissiveBytes),
    });
    textures.push(...built.textures.map((texture) => ({...texture, bankKey: key})));
    bankImages.push({
      role,
      albedoBytes: built.albedoBytes,
      normalBytes: built.normalBytes,
      materialBytes: built.materialBytes,
      emissiveBytes: built.emissiveBytes,
    });
    bankAudits.push({key, role, storage: "atlas", ...built.audit});
  }
  if (textures.length !== source.textures.length) throw new Error("Some client textures were not assigned to a render bank");
  textures.sort((left, right) => left.key.localeCompare(right.key));

  const sourceImageEntries = await Promise.all(source.referencedImageFiles.map(async (file) => ({
    path: file,
    bytes: await readFile(resolveInside(dataRoot, file, `resource image ${file}`)),
  })));
  const targetContentHash = worldContentHash(blockCatalog, generatorCatalog);
  const payload = {
    artifactVersion: 4,
    formatVersion: 4,
    owner,
    targetContentHash,
    textureBanks: bankArtifacts,
    environment: {cloudsDataUrl: dataUrl("image/webp", cloudsBytes)},
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
    bankImages,
  });
  const artifact = {...payload, resourceHash};
  const sourceImages = await Promise.all(sourceImageEntries.map(async ({path, bytes}) => {
    const metadata = await sharp(bytes).metadata();
    return {path, width: metadata.width, height: metadata.height, sha256: sha256([bytes])};
  }));
  const categories = Object.fromEntries(source.catalogs.map(({category, textures: entries}) => [category, entries.length]));
  const audit = {
    formatVersion: 1,
    resourceHash,
    sourceImages,
    unusedFiles: source.unusedFiles,
    textureCount: textures.length,
    variantCount: textures.reduce((total, texture) => total + texture.variants.length, 0),
    categories,
    banks: bankAudits,
    estimatedGpuBytes: bankAudits.reduce((total, bank) => total + bank.atlas.estimatedGpuBytes, 0),
  };
  return {
    artifact,
    artifactText: `${JSON.stringify(artifact, null, 2)}\n`,
    audit,
    auditText: `${JSON.stringify(audit, null, 2)}\n`,
    bankImages,
  };
}

export const paths = {
  packageRoot,
  artifact: resolve(packageRoot, "generated/client-resource-pack.json"),
  audit: resolve(packageRoot, "generated/resource-audit.json"),
  bankImage(role, channel) {
    if (!bankRoles.includes(role)) throw new Error(`Unknown texture bank role ${role}`);
    if (!["albedo", "normal", "material", "emissive"].includes(channel)) throw new Error(`Unknown texture channel ${channel}`);
    return resolve(packageRoot, `generated/texture-banks/${role}-${channel}.png`);
  },
};
