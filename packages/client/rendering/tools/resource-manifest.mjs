import {readdir, readFile} from "node:fs/promises";
import {posix, relative, resolve} from "node:path";
import {parse} from "yaml";
import {
  requireBoolean,
  requireInteger,
  requireKnownFields,
  requireList,
  requireNumber,
  requireRecord,
  requireText,
  resolveInside,
} from "./resource-pack-values.mjs";

const imageExtension = /\.(?:avif|jpe?g|png|webp)$/iu;
const catalogExtension = /\.ya?ml$/iu;
const textureMapNames = new Set(["normal", "height", "material", "emissive"]);
const layerBlendModes = new Set(["normal", "multiply", "overlay"]);
const transformFields = ["rotate", "flipX", "flipY", "shiftX", "shiftY", "hue", "saturation", "brightness", "contrast"];
const textureFields = ["key", "surface", "file", "maps", "transform", "weight", "variants"];
const variantFields = ["weight", "transform", "layers"];
const layerFields = ["albedo", "maps", "mask", "opacity", "blend", "transform"];

function isCategoryPng(file, category) {
  return file.startsWith(`textures/${category}/`)
    && file.endsWith(".png")
    && posix.normalize(file) === file;
}

function environmentImage(value, directory, label) {
  const file = requireText(value, label);
  if (!file.startsWith(`${directory}/`) || !file.endsWith(".webp") || posix.normalize(file) !== file) {
    throw new Error(`${label} must use a WebP inside ${directory}`);
  }
  return file;
}

function environmentDefinition(value) {
  const environment = requireKnownFields(
    requireRecord(value, "environment"),
    ["sky", "clouds", "precipitation"],
    "environment",
  );
  const sky = requireKnownFields(requireRecord(environment.sky, "environment sky"), ["sun", "glow", "star", "moons"], "environment sky");
  const clouds = requireKnownFields(requireRecord(environment.clouds, "environment clouds"), ["texture"], "environment clouds");
  const precipitation = requireKnownFields(
    requireRecord(environment.precipitation, "environment precipitation"),
    ["rain", "rainSplash", "snow"],
    "environment precipitation",
  );
  const moons = requireList(sky.moons, "environment sky moons")
    .map((file, index) => environmentImage(file, "environment/sky", `environment sky moon ${index + 1}`));
  if (moons.length !== 8) throw new RangeError("environment sky must declare exactly eight moon phases");
  if (new Set(moons).size !== moons.length) throw new Error("environment sky moon phases must use distinct images");
  return {
    sky: {
      sun: environmentImage(sky.sun, "environment/sky", "environment sky sun"),
      glow: environmentImage(sky.glow, "environment/sky", "environment sky glow"),
      star: environmentImage(sky.star, "environment/sky", "environment sky star"),
      moons,
    },
    clouds: {
      texture: environmentImage(clouds.texture, "environment/sky", "environment clouds texture"),
    },
    precipitation: {
      rain: environmentImage(precipitation.rain, "environment/weather", "environment precipitation rain"),
      rainSplash: environmentImage(precipitation.rainSplash, "environment/weather", "environment precipitation rain splash"),
      snow: environmentImage(precipitation.snow, "environment/weather", "environment precipitation snow"),
    },
  };
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

function requireOptionalTransform(value, label) {
  if (value == null) return;
  requireKnownFields(requireRecord(value, label), transformFields, label);
}

function requireSectionEntries(values, label, fields) {
  for (const [index, raw] of requireList(values, label).entries()) {
    requireKnownFields(requireRecord(raw, `${label} entry ${index}`), fields, `${label} entry ${index}`);
  }
}

function surfaceProfiles(values) {
  const profiles = new Map();
  for (const raw of requireList(values, "surfaceProfiles")) {
    const entry = requireKnownFields(requireRecord(raw, "surfaceProfiles entry"), [
      "key",
      "normalStrength",
      "occlusionStrength",
      "roughness",
      "roughnessVariation",
      "metallic",
      "metallicVariation",
      "emissive",
      "emissiveThreshold",
    ], "surfaceProfiles entry");
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

function imageReference(value, category, label) {
  const image = requireKnownFields(requireRecord(value, label), ["file"], label);
  const file = requireText(image.file, `${label} file`);
  if (!isCategoryPng(file, category)) {
    throw new Error(`${label} must use a PNG inside textures/${category}`);
  }
  return {file};
}

function textureMaps(value, category, label) {
  if (value == null) return {};
  const maps = requireRecord(value, `${label} maps`);
  for (const name of Object.keys(maps)) {
    if (!textureMapNames.has(name)) throw new Error(`${label} contains unknown map ${name}`);
  }
  if (maps.normal != null && maps.height != null) {
    throw new Error(`${label} cannot declare both normal and height maps`);
  }
  return Object.fromEntries(Object.entries(maps)
    .map(([name, raw]) => [name, imageReference(raw, category, `${label} ${name} map`)]));
}

function requireTextureVariants(texture, textureKey) {
  requireOptionalTransform(texture.transform, `texture ${textureKey} transform`);
  for (const [index, rawVariant] of requireList(texture.variants ?? [], `texture ${textureKey} variants`).entries()) {
    const label = `texture ${textureKey} variant ${index + 1}`;
    const variant = requireKnownFields(requireRecord(rawVariant, label), variantFields, label);
    requireOptionalTransform(variant.transform, `${label} transform`);
    const layers = requireList(variant.layers ?? [], `texture ${textureKey} variant ${index + 1} layers`);
    if (layers.length > 4) throw new RangeError(`${label} cannot contain more than four material layers`);
    for (const [layerIndex, rawLayer] of layers.entries()) {
      const layerLabel = `${label} layer ${layerIndex}`;
      const layer = requireKnownFields(requireRecord(rawLayer, layerLabel), layerFields, layerLabel);
      layer.albedo = imageReference(layer.albedo, texture.category, `${layerLabel} albedo`);
      layer.maps = textureMaps(layer.maps, texture.category, layerLabel);
      if (layer.mask != null) layer.mask = imageReference(layer.mask, texture.category, `${layerLabel} mask`);
      if (layer.opacity != null) requireNumber(layer.opacity, 0.000001, 1, `${layerLabel} opacity`);
      if (layer.blend != null) {
        const blend = requireText(layer.blend, `${layerLabel} blend`);
        if (!layerBlendModes.has(blend)) throw new Error(`${layerLabel} has unsupported blend mode ${blend}`);
      }
      requireOptionalTransform(layer.transform, `${layerLabel} transform`);
    }
  }
}

export async function loadResourceManifest(dataRoot, manifestPath) {
  const manifestText = await readFile(manifestPath, "utf8");
  const manifest = requireKnownFields(requireRecord(parse(manifestText), "Client resource pack manifest"), [
    "formatVersion",
    "owner",
    "textureCatalogs",
    "texturePipeline",
    "environment",
    "surfaceProfiles",
    "models",
    "materials",
    "tints",
    "animations",
  ], "Client resource pack manifest");
  if (manifest.formatVersion !== 9) throw new Error("Unsupported client resource pack source format");
  const owner = requireText(manifest.owner, "Client resource pack owner");
  if (!/^[a-z][a-z0-9_.-]*$/u.test(owner)) throw new Error("Client resource pack owner is invalid");
  const environment = environmentDefinition(manifest.environment);
  requireSectionEntries(manifest.models, "models", ["key", "kind"]);
  requireSectionEntries(manifest.materials, "materials", ["key", "precipitationSurface", "alpha", "alphaCutoff", "doubleSided", "castsShadows", "environmentIntensity", "clearCoat", "clearCoatRoughness", "unlit"]);
  for (const material of manifest.materials) {
    if (!["none", "solid", "water"].includes(material.precipitationSurface)) {
      throw new Error(`Material ${material.key} precipitationSurface must be none, solid, or water`);
    }
  }
  requireSectionEntries(manifest.tints, "tints", ["key", "climate", "coverage", "red", "green", "blue"]);
  requireSectionEntries(manifest.animations, "animations", ["key", "frameDurationMs", "frames"]);

  const catalogFiles = requireList(manifest.textureCatalogs, "textureCatalogs").map((value, index) => {
    const file = requireText(value, `textureCatalogs entry ${index}`);
    if (!catalogExtension.test(file)) throw new Error(`Texture catalog ${file} must be YAML`);
    return file;
  });
  if (catalogFiles.length === 0) throw new Error("Client resource pack needs at least one texture catalog");
  if (new Set(catalogFiles).size !== catalogFiles.length) throw new Error("Client resource pack repeats a texture catalog");

  const catalogs = await Promise.all(catalogFiles.map(async (file) => {
    const path = resolveInside(dataRoot, file, `texture catalog ${file}`);
    const document = requireKnownFields(requireRecord(parse(await readFile(path, "utf8")), `texture catalog ${file}`), ["category", "textures"], `texture catalog ${file}`);
    const category = requireText(document.category, `texture catalog ${file} category`);
    if (!/^[a-z][a-z0-9-]*$/u.test(category)) throw new Error(`Texture catalog category ${category} is invalid`);
    const textures = requireList(document.textures, `texture catalog ${file} textures`).map((rawTexture) => {
      const texture = requireKnownFields(requireRecord(rawTexture, `texture catalog ${file} entry`), textureFields, `texture catalog ${file} entry`);
      return {...texture, category};
    });
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
    texture.maps = textureMaps(texture.maps, texture.category, `Texture ${key}`);
    requireTextureVariants(texture, key);
  }

  const imageReferences = new Set([
    environment.sky.sun,
    environment.sky.glow,
    environment.sky.star,
    ...environment.sky.moons,
    environment.clouds.texture,
    environment.precipitation.rain,
    environment.precipitation.rainSplash,
    environment.precipitation.snow,
  ]);
  for (const texture of textures) {
    imageReferences.add(texture.file);
    for (const map of Object.values(texture.maps)) imageReferences.add(map.file);
    for (const variant of texture.variants ?? []) {
      for (const layer of variant.layers ?? []) {
        imageReferences.add(layer.albedo.file);
        for (const map of Object.values(layer.maps)) imageReferences.add(map.file);
        if (layer.mask != null) imageReferences.add(layer.mask.file);
      }
    }
  }
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
  const knownPipelineFields = new Set(["tileSize", "maximumArrayLayers", "mipmaps"]);
  for (const field of Object.keys(pipeline)) {
    if (!knownPipelineFields.has(field)) throw new Error(`texturePipeline contains unknown field ${field}`);
  }
  const packing = {
    tileSize: requireInteger(pipeline.tileSize, 1, 256, "texturePipeline tileSize"),
    maximumLayers: requireInteger(pipeline.maximumArrayLayers, 1, 2048, "texturePipeline maximumArrayLayers"),
    mipmaps: requireBoolean(pipeline.mipmaps, "texturePipeline mipmaps"),
  };

  return {
    manifest,
    manifestText,
    owner,
    environment,
    catalogs,
    textures,
    surfaceProfiles: profiles,
    packing,
    imageFiles,
    referencedImageFiles,
    unusedFiles,
  };
}
