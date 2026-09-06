import {readdir, readFile} from "node:fs/promises";
import {posix, relative, resolve} from "node:path";
import {parse} from "yaml";
import {
  requireBoolean,
  requireInteger,
  requireList,
  requireNumber,
  requireRecord,
  requireText,
  resolveInside,
} from "./resource-pack-values.mjs";

const imageExtension = /\.(?:avif|jpe?g|png|webp)$/iu;
const catalogExtension = /\.ya?ml$/iu;
const textureMapNames = new Set(["normal", "height", "material", "emissive"]);

function isCategoryPng(file, category) {
  return file.startsWith(`textures/${category}/`)
    && file.endsWith(".png")
    && posix.normalize(file) === file;
}

async function filesBelow(root, current = root) {
  const entries = await readdir(current, {withFileTypes: true});
  const output = [];
  for (const entry of entries) {
    const path = resolve(current, entry.name);
    if (entry.isDirectory()) output.push(...await filesBelow(root, path));
    else if (entry.isFile()) output.push(relative(root, path).split("\\").join("/"));
  }
  return output;
}

function collectImageReferences(value, output) {
  if (Array.isArray(value)) {
    for (const item of value) collectImageReferences(item, output);
    return;
  }
  if (typeof value !== "object" || value === null) return;
  for (const [key, item] of Object.entries(value)) {
    if ((key === "file" || key === "clouds") && typeof item === "string") output.add(item);
    collectImageReferences(item, output);
  }
}

function surfaceProfiles(values) {
  const profiles = new Map();
  for (const raw of requireList(values, "surfaceProfiles")) {
    const entry = requireRecord(raw, "surfaceProfiles entry");
    const key = requireText(entry.key, "surface profile key");
    if (!/^[a-z][a-z0-9-]*$/u.test(key)) throw new Error(`Surface profile key ${key} is invalid`);
    if (profiles.has(key)) throw new Error(`surfaceProfiles repeats ${key}`);
    profiles.set(key, {
      key,
      normalStrength: requireNumber(entry.normalStrength, 0, 4, `surface profile ${key} normalStrength`),
      occlusionStrength: requireNumber(entry.occlusionStrength, 0, 1, `surface profile ${key} occlusionStrength`),
      roughness: requireNumber(entry.roughness, 0, 1, `surface profile ${key} roughness`),
      roughnessVariation: requireNumber(entry.roughnessVariation, 0, 1, `surface profile ${key} roughnessVariation`),
      metallic: requireNumber(entry.metallic, 0, 1, `surface profile ${key} metallic`),
      metallicVariation: requireNumber(entry.metallicVariation, 0, 1, `surface profile ${key} metallicVariation`),
      emissive: requireNumber(entry.emissive, 0, 1, `surface profile ${key} emissive`),
      emissiveThreshold: requireNumber(entry.emissiveThreshold, 0, 1, `surface profile ${key} emissiveThreshold`),
    });
  }
  if (profiles.size === 0) throw new Error("Client resource pack needs at least one surface profile");
  return profiles;
}

function textureMaps(value, category, textureKey) {
  if (value == null) return {};
  const maps = requireRecord(value, `texture ${textureKey} maps`);
  for (const name of Object.keys(maps)) {
    if (!textureMapNames.has(name)) throw new Error(`Texture ${textureKey} contains unknown map ${name}`);
  }
  if (maps.normal != null && maps.height != null) {
    throw new Error(`Texture ${textureKey} cannot declare both normal and height maps`);
  }
  return Object.fromEntries(Object.entries(maps).map(([name, raw]) => {
    const map = requireRecord(raw, `texture ${textureKey} ${name} map`);
    const unknown = Object.keys(map).filter((key) => key !== "file");
    if (unknown.length > 0) throw new Error(`Texture ${textureKey} ${name} map contains unknown field ${unknown[0]}`);
    const file = requireText(map.file, `texture ${textureKey} ${name} map file`);
    if (!isCategoryPng(file, category)) {
      throw new Error(`Texture ${textureKey} ${name} map must use a PNG inside textures/${category}`);
    }
    return [name, {file}];
  }));
}

function requireMappedTextureVariants(texture, textureKey) {
  if (Object.keys(texture.maps).length === 0) return;
  for (const [index, rawVariant] of requireList(texture.variants ?? [], `texture ${textureKey} variants`).entries()) {
    const variant = requireRecord(rawVariant, `texture ${textureKey} variant ${index + 1}`);
    const layers = requireList(variant.layers ?? [], `texture ${textureKey} variant ${index + 1} layers`);
    if (layers.length > 0) {
      throw new Error(`Texture ${textureKey} variant ${index + 1} cannot combine author maps with albedo layers`);
    }
  }
}

export async function loadResourceManifest(dataRoot, manifestPath) {
  const manifestText = await readFile(manifestPath, "utf8");
  const manifest = requireRecord(parse(manifestText), "Client resource pack manifest");
  if (manifest.formatVersion !== 5) throw new Error("Unsupported client resource pack source format");
  const owner = requireText(manifest.owner, "Client resource pack owner");
  if (!/^[a-z][a-z0-9_.-]*$/u.test(owner)) throw new Error("Client resource pack owner is invalid");

  const catalogFiles = requireList(manifest.textureCatalogs, "textureCatalogs").map((value, index) => {
    const file = requireText(value, `textureCatalogs entry ${index}`);
    if (!catalogExtension.test(file)) throw new Error(`Texture catalog ${file} must be YAML`);
    return file;
  });
  if (catalogFiles.length === 0) throw new Error("Client resource pack needs at least one texture catalog");
  if (new Set(catalogFiles).size !== catalogFiles.length) throw new Error("Client resource pack repeats a texture catalog");

  const catalogs = await Promise.all(catalogFiles.map(async (file) => {
    const path = resolveInside(dataRoot, file, `texture catalog ${file}`);
    const document = requireRecord(parse(await readFile(path, "utf8")), `texture catalog ${file}`);
    const category = requireText(document.category, `texture catalog ${file} category`);
    if (!/^[a-z][a-z0-9-]*$/u.test(category)) throw new Error(`Texture catalog category ${category} is invalid`);
    const textures = requireList(document.textures, `texture catalog ${file} textures`).map((texture) => ({
      ...requireRecord(texture, `texture catalog ${file} entry`),
      category,
    }));
    if (textures.length === 0) throw new Error(`Texture catalog ${file} is empty`);
    return {file, category, document, textures};
  }));
  if (new Set(catalogs.map(({category}) => category)).size !== catalogs.length) {
    throw new Error("Client resource pack repeats a texture category");
  }

  const profiles = surfaceProfiles(manifest.surfaceProfiles);
  const textures = catalogs.flatMap(({textures: values}) => values);
  for (const texture of textures) {
    const key = requireText(texture.key, "texture key");
    const file = requireText(texture.file, `texture ${key} file`);
    if (!isCategoryPng(file, texture.category)) {
      throw new Error(`Texture ${key} must use a PNG inside textures/${texture.category}`);
    }
    const profileKey = requireText(texture.surface, `texture ${key} surface`);
    if (!profiles.has(profileKey)) throw new Error(`Texture ${key} references unknown surface profile ${profileKey}`);
    texture.maps = textureMaps(texture.maps, texture.category, key);
    requireMappedTextureVariants(texture, key);
  }

  const imageReferences = new Set();
  collectImageReferences(manifest, imageReferences);
  for (const catalog of catalogs) collectImageReferences(catalog.textures, imageReferences);
  for (const file of imageReferences) resolveInside(dataRoot, file, `resource image ${file}`);
  const referencedImageFiles = [...imageReferences].sort();

  const allFiles = await filesBelow(dataRoot);
  const imageFiles = allFiles.filter((file) => imageExtension.test(file)).sort();
  const unusedFiles = imageFiles.filter((file) => !imageReferences.has(file));
  if (unusedFiles.length > 0) throw new Error(`Client resource data contains unused images: ${unusedFiles.join(", ")}`);
  const missingFiles = [...imageReferences].filter((file) => !imageFiles.includes(file)).sort();
  if (missingFiles.length > 0) throw new Error(`Client resource data is missing images: ${missingFiles.join(", ")}`);
  const unlistedCatalogs = allFiles
    .filter((file) => file.startsWith("textures/") && catalogExtension.test(file) && !catalogFiles.includes(file))
    .sort();
  if (unlistedCatalogs.length > 0) throw new Error(`Client resource data contains unlisted texture catalogs: ${unlistedCatalogs.join(", ")}`);

  const pipeline = requireRecord(manifest.texturePipeline, "texturePipeline");
  const packing = {
    tileSize: requireInteger(pipeline.tileSize, 1, 256, "texturePipeline tileSize"),
    padding: requireInteger(pipeline.atlasPadding, 0, 32, "texturePipeline atlasPadding"),
    columns: requireInteger(pipeline.maximumAtlasColumns, 1, 64, "texturePipeline maximumAtlasColumns"),
    mipmaps: requireBoolean(pipeline.mipmaps, "texturePipeline mipmaps"),
  };
  if (packing.mipmaps && packing.padding < 2) {
    throw new Error("Mipmapped atlases need at least two pixels of edge padding");
  }

  return {
    manifest,
    manifestText,
    owner,
    catalogs,
    textures,
    surfaceProfiles: profiles,
    packing,
    imageFiles,
    referencedImageFiles,
    unusedFiles,
  };
}
