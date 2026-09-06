import {readFile} from "node:fs/promises";
import sharp from "sharp";
import {
  clamp,
  requireBoolean,
  requireInteger,
  requireList,
  requireNumber,
  requireRecord,
  requireText,
  resolveInside,
} from "./resource-pack-values.mjs";

const channelNames = new Set(["normal", "height", "material", "emissive"]);

function wrap(value, size) {
  return (value % size + size) % size;
}

function pixelOffset(x, y, size) {
  return (y * size + x) * 4;
}

function requirePixels(value, size, label) {
  if (!(value instanceof Uint8Array)) throw new TypeError(`${label} must be RGBA bytes`);
  const expected = size * size * 4;
  if (value.byteLength !== expected) throw new RangeError(`${label} must contain ${expected} RGBA bytes`);
  return Buffer.from(value);
}

function channelFiles(value, label) {
  if (value == null) return {};
  const files = requireRecord(value, label);
  for (const key of Object.keys(files)) {
    if (!channelNames.has(key)) throw new Error(`${label} contains unknown channel ${key}`);
  }
  if (files.normal != null && files.height != null) {
    throw new Error(`${label} cannot declare both normal and height`);
  }
  return Object.fromEntries(Object.entries(files).map(([key, file]) => [key, requireText(file, `${label} ${key}`)]));
}

function spatialTransform(value, tileSize, label) {
  if (value == null) return {rotate: 0, flipX: false, flipY: false, shiftX: 0, shiftY: 0};
  const transform = requireRecord(value, label);
  const known = new Set([
    "rotate",
    "flipX",
    "flipY",
    "shiftX",
    "shiftY",
    "hue",
    "saturation",
    "brightness",
    "contrast",
  ]);
  for (const key of Object.keys(transform)) {
    if (!known.has(key)) throw new Error(`${label} contains unknown operation ${key}`);
  }
  const rotate = requireInteger(transform.rotate ?? 0, 0, 270, `${label} rotate`);
  if (rotate % 90 !== 0) throw new Error(`${label} rotate must be 0, 90, 180, or 270`);
  if (transform.hue != null) requireNumber(transform.hue, -360, 360, `${label} hue`);
  if (transform.saturation != null) requireNumber(transform.saturation, 0, 4, `${label} saturation`);
  if (transform.brightness != null) requireNumber(transform.brightness, 0, 4, `${label} brightness`);
  if (transform.contrast != null) requireNumber(transform.contrast, 0, 4, `${label} contrast`);
  return {
    rotate,
    flipX: transform.flipX == null ? false : requireBoolean(transform.flipX, `${label} flipX`),
    flipY: transform.flipY == null ? false : requireBoolean(transform.flipY, `${label} flipY`),
    shiftX: requireInteger(transform.shiftX ?? 0, -tileSize * 8, tileSize * 8, `${label} shiftX`),
    shiftY: requireInteger(transform.shiftY ?? 0, -tileSize * 8, tileSize * 8, `${label} shiftY`),
  };
}

function spatialTransforms(value, tileSize, label) {
  if (value == null) return [];
  const transforms = [];
  for (const [index, entry] of requireList(value, label).entries()) {
    if (entry != null) transforms.push(spatialTransform(entry, tileSize, `${label} ${index}`));
  }
  return transforms;
}

function surfaceProfile(value, label) {
  const profile = requireRecord(value, label);
  return {
    normalStrength: requireNumber(profile.normalStrength, 0, 4, `${label} normalStrength`),
    occlusionStrength: requireNumber(profile.occlusionStrength, 0, 1, `${label} occlusionStrength`),
    roughness: requireNumber(profile.roughness, 0, 1, `${label} roughness`),
    roughnessVariation: requireNumber(profile.roughnessVariation, 0, 1, `${label} roughnessVariation`),
    metallic: requireNumber(profile.metallic, 0, 1, `${label} metallic`),
    metallicVariation: requireNumber(profile.metallicVariation, 0, 1, `${label} metallicVariation`),
    emissive: requireNumber(profile.emissive, 0, 1, `${label} emissive`),
    emissiveThreshold: requireNumber(profile.emissiveThreshold, 0, 1, `${label} emissiveThreshold`),
  };
}

function transformPixels(source, size, transform) {
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
  for (let angle = 0; angle < transform.rotate; angle += 90) {
    spatial((x, y) => y, (x) => size - 1 - x);
  }
  if (transform.flipX) spatial((x) => size - 1 - x, (_x, y) => y);
  if (transform.flipY) spatial((x) => x, (_x, y) => size - 1 - y);
  if (transform.shiftX !== 0 || transform.shiftY !== 0) {
    spatial(
      (x) => wrap(x - transform.shiftX, size),
      (_x, y) => wrap(y - transform.shiftY, size),
    );
  }
  return pixels;
}

function transformPixelSequence(source, size, transforms) {
  let pixels = Buffer.from(source);
  for (const transform of transforms) pixels = transformPixels(pixels, size, transform);
  return pixels;
}

/**
 * Applies the same clockwise rotation, horizontal flip, and vertical flip as
 * the authoring image transform. X points right and Y points down in image
 * space; Z points out of the surface.
 */
export function transformTangentNormal(value, definition = {}) {
  const normal = requireRecord(value, "Tangent normal");
  const x = requireNumber(normal.x, -1, 1, "Tangent normal x");
  const y = requireNumber(normal.y, -1, 1, "Tangent normal y");
  const z = requireNumber(normal.z, -1, 1, "Tangent normal z");
  const source = requireRecord(definition, "Tangent normal transform");
  const known = new Set(["rotate", "flipX", "flipY"]);
  for (const key of Object.keys(source)) {
    if (!known.has(key)) throw new Error(`Tangent normal transform contains unknown operation ${key}`);
  }
  const rotate = requireInteger(source.rotate ?? 0, 0, 270, "Tangent normal transform rotate");
  if (rotate % 90 !== 0) throw new Error("Tangent normal transform rotate must be 0, 90, 180, or 270");
  const transform = {
    rotate,
    flipX: source.flipX == null ? false : requireBoolean(source.flipX, "Tangent normal transform flipX"),
    flipY: source.flipY == null ? false : requireBoolean(source.flipY, "Tangent normal transform flipY"),
  };
  return applyNormalTransform({x, y, z}, transform);
}

function applyNormalTransform({x, y, z}, transform) {
  let transformedX = x;
  let transformedY = y;
  for (let angle = 0; angle < transform.rotate; angle += 90) {
    [transformedX, transformedY] = [-transformedY, transformedX];
  }
  if (transform.flipX) transformedX = -transformedX;
  if (transform.flipY) transformedY = -transformedY;
  return {x: transformedX, y: transformedY, z};
}

function linearChannel(value) {
  const normalized = value / 255;
  return normalized <= 0.04045 ? normalized / 12.92 : ((normalized + 0.055) / 1.055) ** 2.4;
}

function luminance(source, offset, linear) {
  const channel = linear ? linearChannel : (value) => value / 255;
  return channel(source[offset]) * 0.2126
    + channel(source[offset + 1]) * 0.7152
    + channel(source[offset + 2]) * 0.0722;
}

function heightSamples(source, alphaSource, size, linear) {
  const samples = new Float64Array(size * size);
  for (let index = 0; index < samples.length; index += 1) {
    const offset = index * 4;
    samples[index] = luminance(source, offset, linear) * (alphaSource[offset + 3] / 255);
  }
  return samples;
}

function normalsFromHeight(source, albedo, profile, size, linear) {
  const heights = heightSamples(source, albedo, size, linear);
  const heightAt = (x, y) => heights[wrap(y, size) * size + wrap(x, size)];
  const output = Buffer.alloc(albedo.length);
  for (let y = 0; y < size; y += 1) {
    for (let x = 0; x < size; x += 1) {
      const offset = pixelOffset(x, y, size);
      const alpha = albedo[offset + 3];
      if (alpha === 0) {
        output.set([128, 128, 255, 0], offset);
        continue;
      }
      const horizontal = (heightAt(x + 1, y - 1) + 2 * heightAt(x + 1, y) + heightAt(x + 1, y + 1))
        - (heightAt(x - 1, y - 1) + 2 * heightAt(x - 1, y) + heightAt(x - 1, y + 1));
      const vertical = (heightAt(x - 1, y + 1) + 2 * heightAt(x, y + 1) + heightAt(x + 1, y + 1))
        - (heightAt(x - 1, y - 1) + 2 * heightAt(x, y - 1) + heightAt(x + 1, y - 1));
      const normalX = -horizontal * profile.normalStrength;
      const normalY = vertical * profile.normalStrength;
      const inverseLength = 1 / Math.hypot(normalX, normalY, 1);
      output[offset] = Math.round((normalX * inverseLength * 0.5 + 0.5) * 255);
      output[offset + 1] = Math.round((normalY * inverseLength * 0.5 + 0.5) * 255);
      output[offset + 2] = Math.round(inverseLength * 255);
      output[offset + 3] = alpha;
    }
  }
  return output;
}

function transformNormalPixels(source, albedo, size, transforms, label) {
  const spatial = transformPixelSequence(source, size, transforms);
  const output = Buffer.alloc(spatial.length);
  for (let offset = 0; offset < spatial.length; offset += 4) {
    const alpha = albedo[offset + 3];
    if (alpha === 0) {
      output.set([128, 128, 255, 0], offset);
      continue;
    }
    const decoded = {
      x: spatial[offset] / 255 * 2 - 1,
      y: spatial[offset + 1] / 255 * 2 - 1,
      z: spatial[offset + 2] / 255 * 2 - 1,
    };
    const length = Math.hypot(decoded.x, decoded.y, decoded.z);
    if (length < 1 / 64) throw new Error(`${label} contains a zero-length normal`);
    let transformed = decoded;
    for (const transform of transforms) transformed = applyNormalTransform(transformed, transform);
    output[offset] = Math.round((transformed.x / length * 0.5 + 0.5) * 255);
    output[offset + 1] = Math.round((transformed.y / length * 0.5 + 0.5) * 255);
    output[offset + 2] = Math.round((transformed.z / length * 0.5 + 0.5) * 255);
    output[offset + 3] = alpha;
  }
  return output;
}

function generatedMaterial(albedo, profile, size) {
  const output = Buffer.alloc(albedo.length);
  const heights = heightSamples(albedo, albedo, size, true);
  let weightedLuminance = 0;
  let alphaWeight = 0;
  for (let index = 0; index < heights.length; index += 1) {
    const alpha = albedo[index * 4 + 3] / 255;
    weightedLuminance += heights[index];
    alphaWeight += alpha;
  }
  const average = alphaWeight === 0 ? 0 : weightedLuminance / alphaWeight;
  const heightAt = (x, y) => heights[wrap(y, size) * size + wrap(x, size)];
  for (let y = 0; y < size; y += 1) {
    for (let x = 0; x < size; x += 1) {
      const offset = pixelOffset(x, y, size);
      const alpha = albedo[offset + 3];
      if (alpha === 0) {
        output.set([255, Math.round(profile.roughness * 255), Math.round(profile.metallic * 255), 0], offset);
        continue;
      }
      let neighborhood = 0;
      for (let offsetY = -1; offsetY <= 1; offsetY += 1) {
        for (let offsetX = -1; offsetX <= 1; offsetX += 1) neighborhood += heightAt(x + offsetX, y + offsetY);
      }
      const pixelLuminance = heights[y * size + x];
      const cavity = Math.max(0, neighborhood / 9 - pixelLuminance);
      const maximum = Math.max(albedo[offset], albedo[offset + 1], albedo[offset + 2]) / 255;
      const minimum = Math.min(albedo[offset], albedo[offset + 1], albedo[offset + 2]) / 255;
      const saturation = maximum === 0 ? 0 : (maximum - minimum) / maximum;
      const materialSignal = clamp(Math.abs(pixelLuminance - average) * 2.2 + saturation * 0.55);
      output[offset] = Math.round(clamp(1 - cavity * profile.occlusionStrength * 3.2) * 255);
      output[offset + 1] = Math.round(clamp(profile.roughness + (0.5 - pixelLuminance) * profile.roughnessVariation) * 255);
      output[offset + 2] = Math.round(clamp(profile.metallic + materialSignal * profile.metallicVariation) * 255);
      output[offset + 3] = alpha;
    }
  }
  return output;
}

function generatedEmissive(albedo, profile) {
  const output = Buffer.alloc(albedo.length);
  const thresholdRange = Math.max(1e-6, 1 - profile.emissiveThreshold);
  for (let offset = 0; offset < albedo.length; offset += 4) {
    const alpha = albedo[offset + 3];
    const pixelLuminance = luminance(albedo, offset, true) * (alpha / 255);
    const emission = profile.emissive * clamp((pixelLuminance - profile.emissiveThreshold) / thresholdRange);
    output[offset] = Math.round(albedo[offset] * emission);
    output[offset + 1] = Math.round(albedo[offset + 1] * emission);
    output[offset + 2] = Math.round(albedo[offset + 2] * emission);
    output[offset + 3] = alpha;
  }
  return output;
}

function alignAlpha(source, albedo) {
  const output = Buffer.from(source);
  for (let offset = 0; offset < output.length; offset += 4) output[offset + 3] = albedo[offset + 3];
  return output;
}

function rgbaPixels(source, channels) {
  if (channels === 4) return Buffer.from(source);
  const pixels = source.length / channels;
  const output = Buffer.alloc(pixels * 4);
  for (let index = 0; index < pixels; index += 1) {
    const inputOffset = index * channels;
    const outputOffset = index * 4;
    if (channels <= 2) {
      output[outputOffset] = source[inputOffset];
      output[outputOffset + 1] = source[inputOffset];
      output[outputOffset + 2] = source[inputOffset];
      output[outputOffset + 3] = channels === 2 ? source[inputOffset + 1] : 255;
    } else {
      output[outputOffset] = source[inputOffset];
      output[outputOffset + 1] = source[inputOffset + 1];
      output[outputOffset + 2] = source[inputOffset + 2];
      output[outputOffset + 3] = 255;
    }
  }
  return output;
}

function requireChannelEncoding(metadata, channel, label) {
  if (metadata.depth !== "uchar" || metadata.bitsPerSample !== 8 || metadata.isPalette) {
    throw new Error(`${label} must use non-paletted 8-bit samples`);
  }
  const channels = metadata.channels;
  const supported = channel === "height" ? [1, 2, 3, 4] : [3, 4];
  if (!supported.includes(channels)) {
    const layout = channel === "height" ? "grayscale, grayscale-alpha, RGB, or RGBA" : "RGB or RGBA";
    throw new Error(`${label} must use ${layout} channels`);
  }
  if (channel !== "emissive" && metadata.hasProfile) {
    throw new Error(`${label} must not contain an ICC profile`);
  }
}

async function loadChannel(dataRoot, file, tileSize, channel, label) {
  if (!file.toLowerCase().endsWith(".png")) throw new Error(`${label} must be a PNG`);
  const path = resolveInside(dataRoot, file, label);
  const image = sharp(await readFile(path));
  const metadata = await image.metadata();
  if (metadata.format !== "png" || metadata.width !== tileSize || metadata.height !== tileSize) {
    throw new Error(`${label} must be a ${tileSize}x${tileSize} PNG`);
  }
  requireChannelEncoding(metadata, channel, label);
  if (channel === "emissive") return image.toColourspace("srgb").ensureAlpha().raw().toBuffer();
  const {data, info} = await image.raw().toBuffer({resolveWithObject: true});
  return rgbaPixels(data, info.channels);
}

/**
 * Loads optional author maps and resolves the normal, ORM material, and
 * emissive channels. Missing maps are deterministically generated from the
 * transformed albedo and surface profile. Ordered transforms mirror the base
 * texture transform followed by any variant transform. Output alpha always
 * follows albedo.
 */
export async function resolveTextureChannels({
  dataRoot,
  tileSize,
  albedoPixels,
  profile: rawProfile,
  sourceFiles: rawSourceFiles = {},
  transforms: rawTransforms = [],
  label: rawLabel = "texture",
}) {
  const label = requireText(rawLabel, "Texture channel label");
  const size = requireInteger(tileSize, 1, 256, `${label} tile size`);
  const albedo = requirePixels(albedoPixels, size, `${label} albedo`);
  const profile = surfaceProfile(rawProfile, `${label} surface profile`);
  const sourceFiles = channelFiles(rawSourceFiles, `${label} source files`);
  const transforms = spatialTransforms(rawTransforms, size, `${label} channel transforms`);
  const loaded = new Map();
  for (const [channel, file] of Object.entries(sourceFiles)) {
    loaded.set(channel, await loadChannel(dataRoot, file, size, channel, `${label} ${channel} channel`));
  }

  let normal;
  let normalSource;
  if (loaded.has("normal")) {
    normal = transformNormalPixels(loaded.get("normal"), albedo, size, transforms, `${label} normal channel`);
    normalSource = "authored-normal";
  } else if (loaded.has("height")) {
    const height = transformPixelSequence(loaded.get("height"), size, transforms);
    normal = normalsFromHeight(height, albedo, profile, size, false);
    normalSource = "authored-height";
  } else {
    normal = normalsFromHeight(albedo, albedo, profile, size, true);
    normalSource = "generated";
  }

  const authoredMaterial = loaded.get("material");
  const material = authoredMaterial == null
    ? generatedMaterial(albedo, profile, size)
    : alignAlpha(transformPixelSequence(authoredMaterial, size, transforms), albedo);
  const emissive = loaded.has("emissive")
    ? alignAlpha(transformPixelSequence(loaded.get("emissive"), size, transforms), albedo)
    : generatedEmissive(albedo, profile);

  return {
    normal,
    material,
    emissive,
    sources: {
      normal: normalSource,
      material: authoredMaterial == null ? "generated" : "authored-material",
      emissive: loaded.has("emissive") ? "authored-emissive" : "generated",
    },
  };
}
