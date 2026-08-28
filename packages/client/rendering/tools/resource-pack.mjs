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
  if (manifest.formatVersion !== 1) throw new Error("Unsupported client resource pack source format");
  const owner = requireText(manifest.owner, "Client resource pack owner");
  if (!/^[a-z][a-z0-9_.-]*$/u.test(owner)) throw new Error("Client resource pack owner is invalid");

  const blockCatalog = JSON.parse(blockText);
  const generatorCatalog = JSON.parse(generatorText);
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
  const cellSize = tileSize + padding * 2;
  const rows = Math.ceil(textureSources.length / columns);
  const width = nextPowerOfTwo(columns * cellSize);
  const height = nextPowerOfTwo(rows * cellSize);
  const composites = [];
  const textureFiles = [];
  const textures = [];
  const normalizedSheets = new Map();

  async function textureBytes(source) {
    const directFile = source.file;
    const sheetFile = source.sheet;
    if ((directFile == null) === (sheetFile == null)) {
      throw new Error(`Texture ${source.key} must declare exactly one file or sheet`);
    }
    const file = requireText(directFile ?? sheetFile, `texture ${source.key} source`);
    const path = resolve(dataRoot, file);
    if (relative(dataRoot, path).startsWith("..")) throw new Error(`Texture ${source.key} escapes the resource data directory`);
    const sourceBytes = await readFile(path);
    if (directFile != null) {
      const metadata = await sharp(sourceBytes).metadata();
      if (metadata.width !== tileSize || metadata.height !== tileSize) {
        throw new Error(`Texture ${source.key} must be ${tileSize}x${tileSize}`);
      }
      return sourceBytes;
    }

    const sheetColumns = requireInteger(source.columns, 1, 64, `texture ${source.key} sheet columns`);
    const sheetRows = requireInteger(source.rows, 1, 64, `texture ${source.key} sheet rows`);
    const column = requireInteger(source.column, 0, sheetColumns - 1, `texture ${source.key} sheet column`);
    const row = requireInteger(source.row, 0, sheetRows - 1, `texture ${source.key} sheet row`);
    const cacheKey = `${path}:${sheetColumns}:${sheetRows}:${tileSize}`;
    let normalized = normalizedSheets.get(cacheKey);
    if (normalized === undefined) {
      normalized = await sharp(sourceBytes)
        .resize(sheetColumns * tileSize, sheetRows * tileSize, {fit: "fill", kernel: sharp.kernel.lanczos3})
        .png({compressionLevel: 9, adaptiveFiltering: false})
        .toBuffer();
      normalizedSheets.set(cacheKey, normalized);
    }
    return sharp(normalized)
      .extract({left: column * tileSize, top: row * tileSize, width: tileSize, height: tileSize})
      .png({compressionLevel: 9, adaptiveFiltering: false})
      .toBuffer();
  }

  for (const [index, source] of textureSources.entries()) {
    const bytes = await textureBytes(source);
    const cellLeft = index % columns * cellSize;
    const cellTop = Math.floor(index / columns) * cellSize;
    const left = cellLeft + padding;
    const top = cellTop + padding;
    const paddedBytes = padding === 0 ? bytes : await sharp(bytes).extend({
      top: padding,
      bottom: padding,
      left: padding,
      right: padding,
      extendWith: "copy",
    }).png({compressionLevel: 9, adaptiveFiltering: false}).toBuffer();
    composites.push({input: paddedBytes, left: cellLeft, top: cellTop});
    textureFiles.push(Buffer.from(source.key), bytes);
    textures.push({
      key: source.key,
      u0: (left + 0.5) / width,
      v0: 1 - (top + tileSize - 0.5) / height,
      u1: (left + tileSize - 0.5) / width,
      v1: 1 - (top + 0.5) / height,
    });
  }

  const atlasBytes = await sharp({
    create: {width, height, channels: 4, background: {r: 0, g: 0, b: 0, alpha: 0}},
  }).composite(composites).png({compressionLevel: 9, adaptiveFiltering: false}).toBuffer();

  const models = manifest.models.map((entry) => ({key: entry.key, kind: requireText(entry.kind, `model ${entry.key} kind`)}));
  const materials = manifest.materials.map((entry) => ({
    key: entry.key,
    alpha: requireNumber(entry.alpha, 0, 1, `material ${entry.key} alpha`),
    alphaCutoff: requireNumber(entry.alphaCutoff, 0, 1, `material ${entry.key} alphaCutoff`),
    doubleSided: entry.doubleSided === true,
    emissive: requireNumber(entry.emissive, 0, 1, `material ${entry.key} emissive`),
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
    artifactVersion: 1,
    formatVersion: 1,
    owner,
    targetContentHash,
    atlas: {
      width,
      height,
      dataUrl: `data:image/png;base64,${atlasBytes.toString("base64")}`,
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
  ]);
  const artifact = {...payload, resourceHash};
  return {
    artifact,
    artifactText: `${JSON.stringify(artifact, null, 2)}\n`,
    atlasBytes,
  };
}

export const paths = {
  packageRoot,
  artifact: resolve(packageRoot, "generated/client-resource-pack.json"),
  atlas: resolve(packageRoot, "generated/atlas.png"),
};
