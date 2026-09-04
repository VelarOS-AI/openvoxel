import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { dirname, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import sharp from "sharp";
import { parse } from "yaml";

const packageRoot = resolve(dirname(new URL(import.meta.url).pathname), "..");
const dataRoot = resolve(packageRoot, "data");
const manifestPath = resolve(dataRoot, "resource-pack.yml");
const blockCatalogPath = fileURLToPath(import.meta.resolve("@openvoxel/blocks/block-catalog-data"));
const generatorCatalogPath = fileURLToPath(import.meta.resolve("@openvoxel/world-generation/world-generator-catalog-data"));

function requireRecord(value, label) {
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw new TypeError(`${label} must be a record`);
  return value;
}

function requireText(value, label) {
  if (typeof value !== "string" || value.trim() === "") throw new TypeError(`${label} must be non-empty text`);
  return value;
}

function requireInteger(value, minimum, maximum, label) {
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
    throw new RangeError(`${label} must be an integer from ${minimum} through ${maximum}`);
  }
  return value;
}

function requireNumber(value, minimum, maximum, label) {
  if (typeof value !== "number" || !Number.isFinite(value) || value < minimum || value > maximum) {
    throw new RangeError(`${label} must be a number from ${minimum} through ${maximum}`);
  }
  return value;
}

function requireList(value, label) {
  if (!Array.isArray(value)) throw new TypeError(`${label} must be a list`);
  return value;
}

function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (typeof value !== "object" || value === null) return value;
  return Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonical(value[key])]));
}

function stableJson(value) {
  return JSON.stringify(canonical(value));
}

function sha256(parts) {
  const hash = createHash("sha256");
  for (const part of parts) hash.update(part);
  return hash.digest("hex");
}

function nextPowerOfTwo(value) {
  let result = 1;
  while (result < value) result *= 2;
  return result;
}

function uniqueByKey(values, owner, label) {
  const keys = new Set();
  for (const raw of requireList(values, label)) {
    const value = requireRecord(raw, `${label} entry`);
    const key = requireText(value.key, `${label} key`);
    if (!key.startsWith(`${owner}:`)) throw new Error(`${label} key ${key} does not belong to ${owner}`);
    if (keys.has(key)) throw new Error(`${label} repeats ${key}`);
    keys.add(key);
  }
  return keys;
}

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
    if (render.material != null) resources.materials.add(render.material);
    if (render.tint != null) resources.tints.add(render.tint);
    if (render.animation != null) resources.animations.add(render.animation);
    if (render.textures != null) {
      for (const key of [render.textures.all, render.textures.top, render.textures.bottom, render.textures.side]) {
        if (key != null) resources.textures.add(key);
      }
    }
  }
  return resources;
}

function requireCoverage(required, declared, label) {
  for (const key of [...required].sort()) {
    if (!declared.has(key)) throw new Error(`Client resource pack is missing ${label} ${key}`);
  }
}

function worldContentHash(blockCatalog, generatorCatalog) {
  return sha256([stableJson({
    blockCatalogHash: blockCatalog.contentHash,
    packs: [],
    worldGeneratorCatalogHash: generatorCatalog.contentHash,
  })]);
}

export async function buildResourcePack() {
  const [manifestText, blockText, generatorText] = await Promise.all([
    readFile(manifestPath, "utf8"),
    readFile(blockCatalogPath, "utf8"),
    readFile(generatorCatalogPath, "utf8"),
  ]);
  const manifest = requireRecord(parse(manifestText), "Client resource pack manifest");
  if (manifest.formatVersion !== 3) throw new Error("Unsupported client resource pack source format");
  const owner = requireText(manifest.owner, "Client resource pack owner");
  if (!/^[a-z][a-z0-9_.-]*$/u.test(owner)) throw new Error("Client resource pack owner is invalid");

  const blockCatalog = JSON.parse(blockText);
  const generatorCatalog = JSON.parse(generatorText);
  const environmentSource = requireRecord(manifest.environment, "environment");
  const cloudsFile = requireText(environmentSource.clouds, "environment clouds");
  const cloudsPath = resolve(dataRoot, cloudsFile);
  if (relative(dataRoot, cloudsPath).startsWith("..")) throw new Error("Environment clouds escape the resource data directory");
  const cloudsBytes = await readFile(cloudsPath);
  const cloudsMetadata = await sharp(cloudsBytes).metadata();
  if (cloudsMetadata.width == null || cloudsMetadata.height == null || cloudsMetadata.width > 2048 || cloudsMetadata.height > 2048) {
    throw new Error("Environment clouds must be an image no larger than 2048x2048");
  }
  const required = requiredResources(blockCatalog);
  const declaredModels = uniqueByKey(manifest.models, owner, "models");
  const declaredMaterials = uniqueByKey(manifest.materials, owner, "materials");
  const declaredTextures = uniqueByKey(manifest.textures, owner, "textures");
  const declaredTints = uniqueByKey(manifest.tints, owner, "tints");
  const declaredAnimations = uniqueByKey(manifest.animations, owner, "animations");
  requireCoverage(required.models, declaredModels, "model");
  requireCoverage(required.materials, declaredMaterials, "material");
  requireCoverage(required.textures, declaredTextures, "texture");
  requireCoverage(required.tints, declaredTints, "tint");
  requireCoverage(required.animations, declaredAnimations, "animation");

  const atlasSource = requireRecord(manifest.atlas, "atlas");
  const tileSize = requireInteger(atlasSource.tileSize, 1, 256, "atlas tileSize");
  const padding = requireInteger(atlasSource.padding, 0, 16, "atlas padding");
  const columns = requireInteger(atlasSource.columns, 1, 64, "atlas columns");
  const textureSources = [...manifest.textures].sort((left, right) => left.key.localeCompare(right.key));
  const textureVariants = [];
  for (const texture of textureSources) {
    textureVariants.push({
      textureKey: texture.key,
      variantIndex: 0,
      texture,
      recipe: null,
      weight: requireInteger(texture.weight ?? 1, 1, 1024, `texture ${texture.key} base weight`),
    });
    for (const [index, source] of requireList(texture.variants ?? [], `texture ${texture.key} variants`).entries()) {
      const recipe = requireRecord(source, `texture ${texture.key} variant ${index + 1}`);
      textureVariants.push({
        textureKey: texture.key,
        variantIndex: index + 1,
        texture,
        recipe,
        weight: requireInteger(recipe.weight ?? 1, 1, 1024, `texture ${texture.key} variant ${index + 1} weight`),
      });
    }
  }
  const cellSize = tileSize + padding * 2;
  const rows = Math.ceil(textureVariants.length / columns);
  const width = nextPowerOfTwo(columns * cellSize);
  const height = nextPowerOfTwo(rows * cellSize);
  const albedoComposites = [];
  const normalComposites = [];
  const specularComposites = [];
  const textureFiles = [];
  const textures = [];
  const normalizedSheets = new Map();
  const baseTextures = new Map();

  async function sourceTextureBytes(source, label) {
    const directFile = source.file;
    const sheetFile = source.sheet;
    if ((directFile == null) === (sheetFile == null)) {
      throw new Error(`${label} must declare exactly one file or sheet`);
    }
    const file = requireText(directFile ?? sheetFile, `${label} source`);
    const path = resolve(dataRoot, file);
    if (relative(dataRoot, path).startsWith("..")) throw new Error(`${label} escapes the resource data directory`);
    const sourceBytes = await readFile(path);
    if (directFile != null) {
      const metadata = await sharp(sourceBytes).metadata();
      if (metadata.width == null || metadata.height == null || metadata.width !== metadata.height || metadata.width > 256) {
        throw new Error(`${label} must be a square image no larger than 256x256`);
      }
      if (metadata.width === tileSize) return sourceBytes;
      return sharp(sourceBytes)
        .resize(tileSize, tileSize, {fit: "fill", kernel: sharp.kernel.nearest})
        .png({compressionLevel: 9, adaptiveFiltering: false})
        .toBuffer();
    }

    const sheetColumns = requireInteger(source.columns, 1, 64, `${label} sheet columns`);
    const sheetRows = requireInteger(source.rows, 1, 64, `${label} sheet rows`);
    const column = requireInteger(source.column, 0, sheetColumns - 1, `${label} sheet column`);
    const row = requireInteger(source.row, 0, sheetRows - 1, `${label} sheet row`);
    const cacheKey = `${path}:${sheetColumns}:${sheetRows}:${tileSize}`;
    let normalized = normalizedSheets.get(cacheKey);
    if (normalized === undefined) {
      normalized = await sharp(sourceBytes)
        .resize(sheetColumns * tileSize, sheetRows * tileSize, {fit: "fill", kernel: sharp.kernel.nearest})
        .png({compressionLevel: 9, adaptiveFiltering: false})
        .toBuffer();
      normalizedSheets.set(cacheKey, normalized);
    }
    return sharp(normalized)
      .extract({left: column * tileSize, top: row * tileSize, width: tileSize, height: tileSize})
      .png({compressionLevel: 9, adaptiveFiltering: false})
      .toBuffer();
  }

  function blendedChannel(base, layer, mode) {
    if (mode === "normal") return layer;
    if (mode === "multiply") return base * layer / 255;
    if (mode === "overlay") {
      return base < 128
        ? 2 * base * layer / 255
        : 255 - 2 * (255 - base) * (255 - layer) / 255;
    }
    throw new Error(`Unsupported texture blend mode ${mode}`);
  }

  async function mixedTextureBytes(baseBytes, recipe, textureKey, variantIndex) {
    const layers = requireList(recipe.layers, `texture ${textureKey} variant ${variantIndex} layers`);
    if (layers.length === 0 || layers.length > 4) {
      throw new RangeError(`texture ${textureKey} variant ${variantIndex} must contain from 1 through 4 layers`);
    }
    const mixed = Buffer.from(await sharp(baseBytes).ensureAlpha().raw().toBuffer());
    for (const [layerIndex, rawLayer] of layers.entries()) {
      const label = `texture ${textureKey} variant ${variantIndex} layer ${layerIndex}`;
      const layer = requireRecord(rawLayer, label);
      const opacity = requireNumber(layer.opacity, 0, 1, `${label} opacity`);
      if (opacity === 0) throw new RangeError(`${label} opacity must be greater than zero`);
      const mode = layer.blend ?? "normal";
      if (!["normal", "multiply", "overlay"].includes(mode)) throw new Error(`${label} has unsupported blend mode ${mode}`);
      const pixels = await sharp(await sourceTextureBytes(layer, label)).ensureAlpha().raw().toBuffer();
      for (let offset = 0; offset < mixed.length; offset += 4) {
        const baseAlpha = mixed[offset + 3] / 255;
        const layerAlpha = pixels[offset + 3] / 255 * opacity;
        const outputAlpha = layerAlpha + baseAlpha * (1 - layerAlpha);
        for (let channel = 0; channel < 3; channel += 1) {
          const blended = blendedChannel(mixed[offset + channel], pixels[offset + channel], mode);
          const premultiplied = blended * layerAlpha + mixed[offset + channel] * baseAlpha * (1 - layerAlpha);
          mixed[offset + channel] = outputAlpha === 0 ? 0 : Math.round(premultiplied / outputAlpha);
        }
        mixed[offset + 3] = Math.round(outputAlpha * 255);
      }
    }
    return sharp(mixed, {raw: {width: tileSize, height: tileSize, channels: 4}})
      .png({compressionLevel: 9, adaptiveFiltering: false})
      .toBuffer();
  }

  async function textureVariantBytes(texture, recipe, textureKey, variantIndex) {
    let baseBytes = baseTextures.get(textureKey);
    if (baseBytes === undefined) {
      baseBytes = await sourceTextureBytes(texture, `texture ${textureKey} base`);
      baseTextures.set(textureKey, baseBytes);
    }
    if (recipe === null) return baseBytes;
    return mixedTextureBytes(baseBytes, recipe, textureKey, variantIndex);
  }

  async function normalTextureBytes(albedoBytes, strength, label) {
    const source = await sharp(albedoBytes).ensureAlpha().raw().toBuffer();
    const output = Buffer.alloc(source.length);
    const heightAt = (x, y) => {
      let height = 0;
      for (let oy = -1; oy <= 1; oy += 1) {
        for (let ox = -1; ox <= 1; ox += 1) {
          const wrappedX = (x + ox + tileSize) % tileSize;
          const wrappedY = (y + oy + tileSize) % tileSize;
          const offset = (wrappedY * tileSize + wrappedX) * 4;
          const alpha = source[offset + 3] / 255;
          height += (source[offset] * 0.2126 + source[offset + 1] * 0.7152 + source[offset + 2] * 0.0722) / 255 * alpha;
        }
      }
      return height / 9;
    };
    for (let y = 0; y < tileSize; y += 1) {
      for (let x = 0; x < tileSize; x += 1) {
        const offset = (y * tileSize + x) * 4;
        const alpha = source[offset + 3];
        if (alpha === 0) {
          output[offset] = 128;
          output[offset + 1] = 128;
          output[offset + 2] = 255;
          output[offset + 3] = 0;
          continue;
        }
        const dx = (heightAt(x + 1, y) - heightAt(x - 1, y)) * strength;
        const dy = (heightAt(x, y + 1) - heightAt(x, y - 1)) * strength;
        const inverseLength = 1 / Math.hypot(dx, dy, 1);
        output[offset] = Math.round((-dx * inverseLength * 0.5 + 0.5) * 255);
        output[offset + 1] = Math.round((dy * inverseLength * 0.5 + 0.5) * 255);
        output[offset + 2] = Math.round(inverseLength * 255);
        output[offset + 3] = 255;
      }
    }
    return sharp(output, {raw: {width: tileSize, height: tileSize, channels: 4}})
      .png({compressionLevel: 9, adaptiveFiltering: false})
      .toBuffer();
  }

  async function specularTextureBytes(albedoBytes) {
    const source = await sharp(albedoBytes).ensureAlpha().raw().toBuffer();
    const output = Buffer.alloc(source.length);
    for (let offset = 0; offset < source.length; offset += 4) {
      const alpha = source[offset + 3];
      const luminance = (source[offset] * 0.2126 + source[offset + 1] * 0.7152 + source[offset + 2] * 0.0722) / 255;
      const intensity = alpha === 0 ? 0 : Math.round((0.18 + luminance * 0.82) * 255);
      output[offset] = intensity;
      output[offset + 1] = intensity;
      output[offset + 2] = intensity;
      output[offset + 3] = alpha;
    }
    return sharp(output, {raw: {width: tileSize, height: tileSize, channels: 4}})
      .png({compressionLevel: 9, adaptiveFiltering: false})
      .toBuffer();
  }

  async function paddedTextureBytes(bytes) {
    if (padding === 0) return bytes;
    return sharp(bytes).extend({
      top: padding,
      bottom: padding,
      left: padding,
      right: padding,
      extendWith: "copy",
    }).png({compressionLevel: 9, adaptiveFiltering: false}).toBuffer();
  }

  const textureArtifacts = new Map(textureSources.map((source) => [source.key, {key: source.key, variants: []}]));
  for (const [index, variant] of textureVariants.entries()) {
    const {textureKey, variantIndex, texture, recipe, weight} = variant;
    const bytes = await textureVariantBytes(texture, recipe, textureKey, variantIndex);
    const normalStrength = requireNumber(texture.normalStrength ?? 1, 0, 4, `texture ${textureKey} normalStrength`);
    const normalBytes = await normalTextureBytes(bytes, normalStrength, `texture ${textureKey}`);
    const specularBytes = await specularTextureBytes(bytes);
    const cellLeft = index % columns * cellSize;
    const cellTop = Math.floor(index / columns) * cellSize;
    const left = cellLeft + padding;
    const top = cellTop + padding;
    const [paddedAlbedo, paddedNormal, paddedSpecular] = await Promise.all([
      paddedTextureBytes(bytes),
      paddedTextureBytes(normalBytes),
      paddedTextureBytes(specularBytes),
    ]);
    albedoComposites.push({input: paddedAlbedo, left: cellLeft, top: cellTop});
    normalComposites.push({input: paddedNormal, left: cellLeft, top: cellTop});
    specularComposites.push({input: paddedSpecular, left: cellLeft, top: cellTop});
    textureFiles.push(Buffer.from(`${textureKey}:${variantIndex}:${weight}:${normalStrength}`), bytes, normalBytes, specularBytes);
    textureArtifacts.get(textureKey).variants.push({
      u0: (left + 0.5) / width,
      v0: 1 - (top + tileSize - 0.5) / height,
      u1: (left + tileSize - 0.5) / width,
      v1: 1 - (top + 0.5) / height,
      weight,
    });
  }
  textures.push(...textureSources.map((source) => textureArtifacts.get(source.key)));

  const atlasBytes = await sharp({
    create: {width, height, channels: 4, background: {r: 0, g: 0, b: 0, alpha: 0}},
  }).composite(albedoComposites).png({compressionLevel: 9, adaptiveFiltering: false}).toBuffer();
  const normalAtlasBytes = await sharp({
    create: {width, height, channels: 4, background: {r: 128, g: 128, b: 255, alpha: 0}},
  }).composite(normalComposites).png({compressionLevel: 9, adaptiveFiltering: false}).toBuffer();
  const specularAtlasBytes = await sharp({
    create: {width, height, channels: 4, background: {r: 0, g: 0, b: 0, alpha: 0}},
  }).composite(specularComposites).png({compressionLevel: 9, adaptiveFiltering: false}).toBuffer();

  const models = manifest.models.map((entry) => ({key: entry.key, kind: requireText(entry.kind, `model ${entry.key} kind`)}));
  const materials = manifest.materials.map((entry) => ({
    key: entry.key,
    alpha: requireNumber(entry.alpha, 0, 1, `material ${entry.key} alpha`),
    alphaCutoff: requireNumber(entry.alphaCutoff, 0, 1, `material ${entry.key} alphaCutoff`),
    doubleSided: entry.doubleSided === true,
    emissive: requireNumber(entry.emissive, 0, 1, `material ${entry.key} emissive`),
    roughness: requireNumber(entry.roughness, 0, 1, `material ${entry.key} roughness`),
    specular: requireNumber(entry.specular, 0, 1, `material ${entry.key} specular`),
    unlit: entry.unlit === true,
  }));
  const tints = manifest.tints.map((entry) => ({
    key: entry.key,
    red: requireNumber(entry.red, 0, 1, `tint ${entry.key} red`),
    green: requireNumber(entry.green, 0, 1, `tint ${entry.key} green`),
    blue: requireNumber(entry.blue, 0, 1, `tint ${entry.key} blue`),
  }));
  const animations = manifest.animations.map((entry) => {
    const frames = requireList(entry.frames, `animation ${entry.key} frames`).map((frame) => requireText(frame, `animation ${entry.key} frame`));
    if (frames.length === 0) throw new Error(`Animation ${entry.key} needs at least one frame`);
    for (const frame of frames) if (!declaredTextures.has(frame)) throw new Error(`Animation ${entry.key} references unknown texture ${frame}`);
    return {
      key: entry.key,
      frameDurationMs: requireInteger(entry.frameDurationMs, 16, 60_000, `animation ${entry.key} frameDurationMs`),
      frames,
    };
  });
  const targetContentHash = worldContentHash(blockCatalog, generatorCatalog);
  const payload = {
    artifactVersion: 3,
    formatVersion: 3,
    owner,
    targetContentHash,
    atlas: {
      width,
      height,
      albedoDataUrl: `data:image/png;base64,${atlasBytes.toString("base64")}`,
      normalDataUrl: `data:image/png;base64,${normalAtlasBytes.toString("base64")}`,
      specularDataUrl: `data:image/png;base64,${specularAtlasBytes.toString("base64")}`,
    },
    environment: {
      cloudsDataUrl: `data:image/webp;base64,${cloudsBytes.toString("base64")}`,
    },
    models,
    materials,
    textures,
    tints,
    animations,
  };
  const resourceHash = sha256([
    stableJson(payload),
    ...textureFiles,
    atlasBytes,
    normalAtlasBytes,
    specularAtlasBytes,
    cloudsBytes,
  ]);
  const artifact = {...payload, resourceHash};
  return {
    artifact,
    artifactText: `${JSON.stringify(artifact, null, 2)}\n`,
    atlasBytes,
    normalAtlasBytes,
    specularAtlasBytes,
  };
}

export const paths = {
  packageRoot,
  artifact: resolve(packageRoot, "generated/client-resource-pack.json"),
  atlas: resolve(packageRoot, "generated/atlas.png"),
  normalAtlas: resolve(packageRoot, "generated/normal-atlas.png"),
  specularAtlas: resolve(packageRoot, "generated/specular-atlas.png"),
};
