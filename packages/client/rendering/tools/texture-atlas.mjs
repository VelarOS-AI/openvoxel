import {readFile} from "node:fs/promises";
import sharp from "sharp";
import {
  clamp,
  requireBoolean,
  requireInteger,
  requireList,
  requireNumber,
  requireRecord,
  resolveInside,
} from "./resource-pack-values.mjs";
import {resolveTextureChannels} from "./texture-channels.mjs";

const pngOptions = {compressionLevel: 9, adaptiveFiltering: false};

function wrap(value, size) {
  return (value % size + size) % size;
}

function pixelOffset(x, y, size) {
  return (y * size + x) * 4;
}

function transformDefinition(value, label, tileSize) {
  if (value == null) return null;
  const source = requireRecord(value, label);
  const known = new Set(["rotate", "flipX", "flipY", "shiftX", "shiftY", "hue", "saturation", "brightness", "contrast"]);
  for (const key of Object.keys(source)) {
    if (!known.has(key)) throw new Error(`${label} contains unknown operation ${key}`);
  }
  const rotate = requireInteger(source.rotate ?? 0, 0, 270, `${label} rotate`);
  if (rotate % 90 !== 0) throw new Error(`${label} rotate must be 0, 90, 180, or 270`);
  return {
    rotate,
    flipX: source.flipX == null ? false : requireBoolean(source.flipX, `${label} flipX`),
    flipY: source.flipY == null ? false : requireBoolean(source.flipY, `${label} flipY`),
    shiftX: requireInteger(source.shiftX ?? 0, -tileSize * 8, tileSize * 8, `${label} shiftX`),
    shiftY: requireInteger(source.shiftY ?? 0, -tileSize * 8, tileSize * 8, `${label} shiftY`),
    hue: requireNumber(source.hue ?? 0, -360, 360, `${label} hue`),
    saturation: requireNumber(source.saturation ?? 1, 0, 4, `${label} saturation`),
    brightness: requireNumber(source.brightness ?? 1, 0, 4, `${label} brightness`),
    contrast: requireNumber(source.contrast ?? 1, 0, 4, `${label} contrast`),
  };
}

function transformPixels(source, definition, size) {
  if (definition == null) return Buffer.from(source);
  let pixels = Buffer.from(source);
  const spatial = (sourceX, sourceY) => {
    const output = Buffer.alloc(pixels.length);
    for (let y = 0; y < size; y += 1) {
      for (let x = 0; x < size; x += 1) {
        const from = pixelOffset(sourceX(x, y), sourceY(x, y), size);
        pixels.copy(output, pixelOffset(x, y, size), from, from + 4);
      }
    }
    pixels = output;
  };

  for (let angle = 0; angle < definition.rotate; angle += 90) {
    spatial((x, y) => y, (x) => size - 1 - x);
  }
  if (definition.flipX) spatial((x) => size - 1 - x, (_x, y) => y);
  if (definition.flipY) spatial((x) => x, (_x, y) => size - 1 - y);
  if (definition.shiftX !== 0 || definition.shiftY !== 0) {
    spatial(
      (x) => wrap(x - definition.shiftX, size),
      (_x, y) => wrap(y - definition.shiftY, size),
    );
  }

  if (definition.hue === 0 && definition.saturation === 1 && definition.brightness === 1 && definition.contrast === 1) {
    return pixels;
  }

  for (let offset = 0; offset < pixels.length; offset += 4) {
    if (pixels[offset + 3] === 0) continue;
    const red = pixels[offset] / 255;
    const green = pixels[offset + 1] / 255;
    const blue = pixels[offset + 2] / 255;
    const maximum = Math.max(red, green, blue);
    const minimum = Math.min(red, green, blue);
    const lightness = (maximum + minimum) / 2;
    const delta = maximum - minimum;
    let hue = 0;
    let saturation = 0;
    if (delta !== 0) {
      saturation = delta / (1 - Math.abs(2 * lightness - 1));
      if (maximum === red) hue = ((green - blue) / delta) % 6;
      else if (maximum === green) hue = (blue - red) / delta + 2;
      else hue = (red - green) / delta + 4;
      hue /= 6;
      if (hue < 0) hue += 1;
    }
    hue = wrap(hue + definition.hue / 360, 1);
    saturation = clamp(saturation * definition.saturation);
    const nextLightness = clamp((lightness * definition.brightness - 0.5) * definition.contrast + 0.5);
    const chroma = (1 - Math.abs(2 * nextLightness - 1)) * saturation;
    const sector = hue * 6;
    const middle = chroma * (1 - Math.abs(sector % 2 - 1));
    let nextRed = 0;
    let nextGreen = 0;
    let nextBlue = 0;
    if (sector < 1) [nextRed, nextGreen] = [chroma, middle];
    else if (sector < 2) [nextRed, nextGreen] = [middle, chroma];
    else if (sector < 3) [nextGreen, nextBlue] = [chroma, middle];
    else if (sector < 4) [nextGreen, nextBlue] = [middle, chroma];
    else if (sector < 5) [nextRed, nextBlue] = [middle, chroma];
    else [nextRed, nextBlue] = [chroma, middle];
    const match = nextLightness - chroma / 2;
    pixels[offset] = Math.round(clamp(nextRed + match) * 255);
    pixels[offset + 1] = Math.round(clamp(nextGreen + match) * 255);
    pixels[offset + 2] = Math.round(clamp(nextBlue + match) * 255);
  }
  return pixels;
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

function mixLayer(base, pixels, opacity, mode) {
  for (let offset = 0; offset < base.length; offset += 4) {
    const baseAlpha = base[offset + 3] / 255;
    const layerAlpha = pixels[offset + 3] / 255 * opacity;
    const outputAlpha = layerAlpha + baseAlpha * (1 - layerAlpha);
    for (let channel = 0; channel < 3; channel += 1) {
      const blended = blendedChannel(base[offset + channel], pixels[offset + channel], mode);
      const premultiplied = blended * layerAlpha + base[offset + channel] * baseAlpha * (1 - layerAlpha);
      base[offset + channel] = outputAlpha === 0 ? 0 : Math.round(premultiplied / outputAlpha);
    }
    base[offset + 3] = Math.round(outputAlpha * 255);
  }
}

async function paddedPng(pixels, size, padding) {
  const image = sharp(pixels, {raw: {width: size, height: size, channels: 4}});
  if (padding > 0) {
    image.extend({top: padding, bottom: padding, left: padding, right: padding, extendWith: "copy"});
  }
  return image.png(pngOptions).toBuffer();
}

function channelTransform(definition) {
  if (definition == null) return null;
  return {
    rotate: definition.rotate,
    flipX: definition.flipX,
    flipY: definition.flipY,
    shiftX: definition.shiftX,
    shiftY: definition.shiftY,
  };
}

function channelSourceFiles(texture) {
  const maps = requireRecord(texture.maps ?? {}, `texture ${texture.key} maps`);
  return Object.fromEntries(Object.entries(maps).map(([channel, raw]) => {
    const source = requireRecord(raw, `texture ${texture.key} ${channel} map`);
    return [channel, source.file];
  }));
}

export async function buildTextureAtlas({dataRoot, atlas, textureSources, surfaceProfiles}) {
  const {tileSize, padding, columns, mipmaps} = atlas;
  const sourceBytes = new Map();
  const sourcePixels = new Map();

  async function bytesFor(path) {
    let bytes = sourceBytes.get(path);
    if (bytes === undefined) {
      bytes = await readFile(path);
      sourceBytes.set(path, bytes);
    }
    return bytes;
  }

  async function pixelsFor(source, label) {
    const file = source.file;
    if (typeof file !== "string") throw new Error(`${label} must declare one source file`);
    const path = resolveInside(dataRoot, file, `${label} source`);
    const cacheKey = `${path}:${tileSize}`;
    let pixels = sourcePixels.get(cacheKey);
    if (pixels === undefined) {
      const image = sharp(await bytesFor(path));
      const metadata = await image.metadata();
      if (metadata.format !== "png" || metadata.width !== tileSize || metadata.height !== tileSize) {
        throw new Error(`${label} must be a ${tileSize}x${tileSize} PNG`);
      }
      pixels = await image.ensureAlpha().raw().toBuffer();
      sourcePixels.set(cacheKey, pixels);
    }
    const transform = transformDefinition(source.transform, `${label} transform`, tileSize);
    return {pixels: transformPixels(pixels, transform, tileSize), transform};
  }

  async function variantPixels(texture, recipe, textureKey, variantIndex) {
    const base = await pixelsFor(texture, `texture ${textureKey} base`);
    let pixels = base.pixels;
    const channelTransforms = [channelTransform(base.transform)];
    if (recipe == null) return {albedo: pixels, channelTransforms};
    const transform = transformDefinition(recipe.transform, `texture ${textureKey} variant ${variantIndex} transform`, tileSize);
    const layers = requireList(recipe.layers ?? [], `texture ${textureKey} variant ${variantIndex} layers`);
    if (transform == null && layers.length === 0) {
      throw new Error(`texture ${textureKey} variant ${variantIndex} needs a transform or at least one layer`);
    }
    if (layers.length > 4) throw new RangeError(`texture ${textureKey} variant ${variantIndex} cannot contain more than four layers`);
    if (layers.length > 0 && Object.keys(texture.maps ?? {}).length > 0) {
      throw new Error(`texture ${textureKey} variant ${variantIndex} cannot combine author maps with albedo layers`);
    }
    pixels = transformPixels(pixels, transform, tileSize);
    channelTransforms.push(channelTransform(transform));
    for (const [layerIndex, rawLayer] of layers.entries()) {
      const label = `texture ${textureKey} variant ${variantIndex} layer ${layerIndex}`;
      const layer = requireRecord(rawLayer, label);
      const opacity = requireNumber(layer.opacity ?? 1, 0.000001, 1, `${label} opacity`);
      const mode = layer.blend ?? "normal";
      if (!["normal", "multiply", "overlay"].includes(mode)) throw new Error(`${label} has unsupported blend mode ${mode}`);
      mixLayer(pixels, (await pixelsFor(layer, label)).pixels, opacity, mode);
    }
    return {albedo: pixels, channelTransforms};
  }

  const sortedTextures = [...textureSources].sort((left, right) => left.key.localeCompare(right.key));
  const variants = [];
  for (const texture of sortedTextures) {
    variants.push({texture, recipe: null, variantIndex: 0, weight: requireInteger(texture.weight ?? 1, 1, 1024, `texture ${texture.key} base weight`)});
    for (const [index, rawRecipe] of requireList(texture.variants ?? [], `texture ${texture.key} variants`).entries()) {
      const recipe = requireRecord(rawRecipe, `texture ${texture.key} variant ${index + 1}`);
      variants.push({
        texture,
        recipe,
        variantIndex: index + 1,
        weight: requireInteger(recipe.weight ?? 1, 1, 1024, `texture ${texture.key} variant ${index + 1} weight`),
      });
    }
  }

  const cellSize = tileSize + padding * 2;
  const rows = Math.ceil(variants.length / columns);
  const width = columns * cellSize;
  const height = rows * cellSize;
  const composites = {albedo: [], normal: [], material: [], emissive: []};
  const textureArtifacts = new Map(sortedTextures.map(({key}) => [key, {key, variants: []}]));
  let emissiveVariantCount = 0;
  const channelSources = {normal: {}, material: {}, emissive: {}};

  for (const [index, {texture, recipe, variantIndex, weight}] of variants.entries()) {
    const profile = surfaceProfiles.get(texture.surface);
    if (profile == null) throw new Error(`Texture ${texture.key} references unknown surface profile ${texture.surface}`);
    const {albedo, channelTransforms} = await variantPixels(texture, recipe, texture.key, variantIndex);
    const channels = await resolveTextureChannels({
      dataRoot,
      tileSize,
      albedoPixels: albedo,
      profile,
      sourceFiles: channelSourceFiles(texture),
      transforms: channelTransforms,
      label: `texture ${texture.key} variant ${variantIndex}`,
    });
    for (const channel of ["normal", "material", "emissive"]) {
      const source = channels.sources[channel];
      channelSources[channel][source] = (channelSources[channel][source] ?? 0) + 1;
    }
    const cellLeft = index % columns * cellSize;
    const cellTop = Math.floor(index / columns) * cellSize;
    const left = cellLeft + padding;
    const top = cellTop + padding;
    const [paddedAlbedo, paddedNormal, paddedMaterial, paddedEmissive] = await Promise.all([
      paddedPng(albedo, tileSize, padding),
      paddedPng(channels.normal, tileSize, padding),
      paddedPng(channels.material, tileSize, padding),
      paddedPng(channels.emissive, tileSize, padding),
    ]);
    composites.albedo.push({input: paddedAlbedo, left: cellLeft, top: cellTop});
    composites.normal.push({input: paddedNormal, left: cellLeft, top: cellTop});
    composites.material.push({input: paddedMaterial, left: cellLeft, top: cellTop});
    composites.emissive.push({input: paddedEmissive, left: cellLeft, top: cellTop});
    if (channels.sources.emissive === "authored-emissive" || profile.emissive > 0) emissiveVariantCount += 1;
    textureArtifacts.get(texture.key).variants.push({
      u0: (left + 0.5) / width,
      v0: 1 - (top + tileSize - 0.5) / height,
      u1: (left + tileSize - 0.5) / width,
      v1: 1 - (top + 0.5) / height,
      weight,
    });
  }

  async function atlasBytes(channel, background) {
    return sharp({create: {width, height, channels: 4, background}})
      .composite(composites[channel])
      .png(pngOptions)
      .toBuffer();
  }

  const [albedoBytes, normalBytes, materialBytes, emissiveBytes] = await Promise.all([
    atlasBytes("albedo", {r: 0, g: 0, b: 0, alpha: 0}),
    atlasBytes("normal", {r: 128, g: 128, b: 255, alpha: 0}),
    atlasBytes("material", {r: 255, g: 255, b: 0, alpha: 0}),
    atlasBytes("emissive", {r: 0, g: 0, b: 0, alpha: 0}),
  ]);
  const categoryCounts = Object.fromEntries([...new Set(sortedTextures.map(({category}) => category))]
    .sort()
    .map((category) => [category, sortedTextures.filter((texture) => texture.category === category).length]));
  const baseGpuBytes = width * height * 4 * 4;
  return {
    width,
    height,
    mipmaps,
    textures: sortedTextures.map(({key}) => textureArtifacts.get(key)),
    albedoBytes,
    normalBytes,
    materialBytes,
    emissiveBytes,
    audit: {
      textureCount: sortedTextures.length,
      variantCount: variants.length,
      categories: categoryCounts,
      channels: {
        albedo: variants.length,
        normal: variants.length,
        material: variants.length,
        emissive: emissiveVariantCount,
      },
      channelSources,
      atlas: {
        width,
        height,
        tileSize,
        padding,
        columns,
        rows,
        mipmaps,
        occupancy: Number((variants.length * tileSize * tileSize / (width * height)).toFixed(6)),
        estimatedGpuBytes: Math.ceil(baseGpuBytes * (mipmaps ? 4 / 3 : 1)),
      },
    },
  };
}

export {transformPixels};
