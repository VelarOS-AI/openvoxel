import {readFile} from "node:fs/promises";
import sharp from "sharp";
import {
  clamp,
  compareText,
  requireBoolean,
  requireInteger,
  requireList,
  requireNumber,
  requireRecord,
  resolveInside,
} from "./resource-pack-values.mjs";
import {resolveTextureChannels} from "./texture-channels.mjs";
import {buildPbrTextureArrayMipLevels} from "./texture-mipmaps.mjs";

const channelNames = ["albedo", "normal", "material", "emissive"];
const maximumTextureArrayChannelBytes = 16 * 1024 * 1024;

function wrap(value, size) {
  return (value % size + size) % size;
}

function pixelOffset(x, y, size) {
  return (y * size + x) * 4;
}

/**
 * WebGL 2 does not permit UNPACK_FLIP_Y_WEBGL for texImage3D uploads. Generated
 * array layers therefore use bottom-to-top GPU row order instead of deferring
 * the conversion to runtime. This is a storage conversion, not a normal-space
 * transform, so every channel keeps its RGBA values unchanged.
 */
function textureArrayLayerBytes(source, width, height = width) {
  const rowBytes = width * 4;
  if (source.byteLength !== rowBytes * height) throw new Error("Texture array layer must contain one complete RGBA8 tile");
  const output = Buffer.allocUnsafe(source.byteLength);
  for (let outputY = 0; outputY < height; outputY += 1) {
    const sourceY = height - 1 - outputY;
    source.copy(output, outputY * rowBytes, sourceY * rowBytes, (sourceY + 1) * rowBytes);
  }
  return output;
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

/**
 * Builds four layer-major RGBA8 buffers. For every layer index, albedo, normal,
 * material, and emissive contain the same logical texture variant.
 */
export async function buildTextureArray({dataRoot, array, textureSources, surfaceProfiles, role = "opaque", textureAlphaCutoffs = new Map()}) {
  const {tileSize, maximumLayers, mipmaps} = array;
  const sourceBytes = new Map();
  const sourcePixels = new Map();

  function alphaCutoffFor(textureKey) {
    if (role !== "cutout") return null;
    if (!(textureAlphaCutoffs instanceof Map) || !textureAlphaCutoffs.has(textureKey)) {
      throw new Error(`Cutout texture ${textureKey} has no material alpha cutoff`);
    }
    const cutoff = textureAlphaCutoffs.get(textureKey);
    if (typeof cutoff !== "number" || !Number.isFinite(cutoff) || cutoff < 0 || cutoff > 1) {
      throw new RangeError(`Cutout texture ${textureKey} alpha cutoff must be from zero through one`);
    }
    return cutoff;
  }

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

  const sortedTextures = [...textureSources].sort((left, right) => compareText(left.key, right.key));
  const variants = [];
  for (const texture of sortedTextures) {
    variants.push({
      texture,
      recipe: null,
      variantIndex: 0,
      weight: requireInteger(texture.weight ?? 1, 1, 1024, `texture ${texture.key} base weight`),
      alphaCutoff: alphaCutoffFor(texture.key),
    });
    for (const [index, rawRecipe] of requireList(texture.variants ?? [], `texture ${texture.key} variants`).entries()) {
      const recipe = requireRecord(rawRecipe, `texture ${texture.key} variant ${index + 1}`);
      variants.push({
        texture,
        recipe,
        variantIndex: index + 1,
        weight: requireInteger(recipe.weight ?? 1, 1, 1024, `texture ${texture.key} variant ${index + 1} weight`),
        alphaCutoff: alphaCutoffFor(texture.key),
      });
    }
  }
  if (variants.length > maximumLayers) {
    throw new RangeError(`Texture array needs ${variants.length} layers but texturePipeline.maximumArrayLayers is ${maximumLayers}`);
  }
  const channelByteLength = tileSize * tileSize * variants.length * 4;
  if (channelByteLength > maximumTextureArrayChannelBytes) {
    throw new RangeError(`Texture array needs ${channelByteLength} bytes per channel; the limit is ${maximumTextureArrayChannelBytes}`);
  }

  const channelLayers = Object.fromEntries(channelNames.map((channel) => [channel, []]));
  const textureArtifacts = new Map(sortedTextures.map(({key}) => [key, {
    key,
    alphaCutoff: alphaCutoffFor(key),
    variants: [],
  }]));
  let emissiveVariantCount = 0;
  const channelSources = {normal: {}, material: {}, emissive: {}};

  for (const [layer, {texture, recipe, variantIndex, weight}] of variants.entries()) {
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
    channelLayers.albedo.push(albedo);
    channelLayers.normal.push(channels.normal);
    channelLayers.material.push(channels.material);
    channelLayers.emissive.push(channels.emissive);
    for (const channel of ["normal", "material", "emissive"]) {
      const source = channels.sources[channel];
      channelSources[channel][source] = (channelSources[channel][source] ?? 0) + 1;
    }
    if (channels.sources.emissive === "authored-emissive" || profile.emissive > 0) emissiveVariantCount += 1;
    textureArtifacts.get(texture.key).variants.push({layer, weight});
  }

  const generatedLevels = buildPbrTextureArrayMipLevels({
    width: tileSize,
    height: tileSize,
    albedoLayers: channelLayers.albedo,
    normalLayers: channelLayers.normal,
    materialLayers: channelLayers.material,
    emissiveLayers: channelLayers.emissive,
    mipmaps,
    alphaCutoffs: variants.map(({alphaCutoff}) => alphaCutoff === 0 ? null : alphaCutoff),
  });
  const levels = generatedLevels.map(({width, height, layers}) => {
    const bytes = Object.fromEntries(channelNames.map((channel) => [
      channel,
      Buffer.concat(layers.map((layer) => textureArrayLayerBytes(layer[channel], width, height))),
    ]));
    const expectedBytes = width * height * variants.length * 4;
    for (const channel of channelNames) {
      if (bytes[channel].byteLength !== expectedBytes) {
        throw new Error(`Texture array ${channel} channel has ${bytes[channel].byteLength} bytes; expected ${expectedBytes}`);
      }
    }
    return {
      width,
      height,
      albedoBytes: bytes.albedo,
      normalBytes: bytes.normal,
      materialBytes: bytes.material,
      emissiveBytes: bytes.emissive,
    };
  });
  const channelMipBytes = levels.reduce((total, level) => total + level.albedoBytes.byteLength, 0);
  if (channelMipBytes > maximumTextureArrayChannelBytes) {
    throw new RangeError(`Texture array mip chain needs ${channelMipBytes} bytes per channel; the limit is ${maximumTextureArrayChannelBytes}`);
  }
  const categoryCounts = Object.fromEntries([...new Set(sortedTextures.map(({category}) => category))]
    .sort(compareText)
    .map((category) => [category, sortedTextures.filter((texture) => texture.category === category).length]));
  const gpuBytes = channelMipBytes * channelNames.length;
  return {
    width: tileSize,
    height: tileSize,
    layerCount: variants.length,
    mipmaps,
    levels,
    textures: sortedTextures.map(({key}) => textureArtifacts.get(key)),
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
      array: {
        width: tileSize,
        height: tileSize,
        layers: variants.length,
        mipmaps,
        mipLevelCount: levels.length,
        alphaCutoffs: [...new Set(variants.map(({alphaCutoff}) => alphaCutoff))],
        gpuBytes,
      },
    },
  };
}

export {textureArrayLayerBytes, transformPixels};
