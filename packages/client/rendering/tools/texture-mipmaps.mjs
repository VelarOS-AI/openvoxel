const channelNames = ["albedo", "normal", "material", "emissive"];
const srgbToLinear = Array.from({length: 256}, (_value, byte) => {
  const encoded = byte / 255;
  return encoded <= 0.04045
    ? encoded / 12.92
    : ((encoded + 0.055) / 1.055) ** 2.4;
});

function requireDimension(value, label) {
  if (!Number.isSafeInteger(value) || value < 1) throw new RangeError(`${label} must be a positive safe integer`);
  return value;
}

function requireAlphaCutoffs(value, layerCount) {
  if (!Array.isArray(value) || value.length !== layerCount) {
    throw new RangeError(`Texture mip alphaCutoffs must contain ${layerCount} entries`);
  }
  return value.map((cutoff, layer) => {
    if (cutoff === null) return null;
    if (typeof cutoff !== "number" || !Number.isFinite(cutoff) || cutoff <= 0 || cutoff > 1) {
      throw new RangeError(`Texture mip alpha cutoff for layer ${layer} must be null or greater than zero through one`);
    }
    return cutoff;
  });
}

function requireLayers(value, layerCount, byteLength, channel) {
  if (!Array.isArray(value) || value.length !== layerCount) {
    throw new RangeError(`Texture mip ${channel} must contain ${layerCount} layers`);
  }
  return value.map((layer, index) => {
    if (!(layer instanceof Uint8Array) || layer.byteLength !== byteLength) {
      throw new RangeError(`Texture mip ${channel} layer ${index} must contain ${byteLength} RGBA8 bytes`);
    }
    return Buffer.from(layer);
  });
}

function linearToSrgbByte(linear) {
  const encoded = linear <= 0.0031308
    ? linear * 12.92
    : 1.055 * linear ** (1 / 2.4) - 0.055;
  return Math.round(Math.min(1, Math.max(0, encoded)) * 255);
}

function axisContributions(sourceSize, targetSize) {
  return Array.from({length: targetSize}, (_value, target) => {
    const start = target * sourceSize / targetSize;
    const end = (target + 1) * sourceSize / targetSize;
    const samples = [];
    for (let source = Math.floor(start); source < Math.ceil(end); source += 1) {
      const weight = Math.min(end, source + 1) - Math.max(start, source);
      if (weight > 0) samples.push({source, weight});
    }
    return samples;
  });
}

function outputOffset(x, y, width) {
  return (y * width + x) * 4;
}

function sampleOffset(x, y, width) {
  return (y * width + x) * 4;
}

function averageByte(total, totalWeight) {
  return Math.round(Math.min(255, Math.max(0, total / totalWeight)));
}

function downsampleLayer(source, sourceWidth, sourceHeight, targetWidth, targetHeight) {
  const target = Object.fromEntries(channelNames.map((channel) => [channel, Buffer.alloc(targetWidth * targetHeight * 4)]));
  const horizontal = axisContributions(sourceWidth, targetWidth);
  const vertical = axisContributions(sourceHeight, targetHeight);

  for (let y = 0; y < targetHeight; y += 1) {
    for (let x = 0; x < targetWidth; x += 1) {
      const output = outputOffset(x, y, targetWidth);
      const albedoLinear = [0, 0, 0];
      const emissiveLinear = [0, 0, 0];
      const material = [0, 0, 0];
      const normal = [0, 0, 0];
      let alpha = 0;
      let totalWeight = 0;
      let visibleWeight = 0;

      for (const verticalSample of vertical[y]) {
        for (const horizontalSample of horizontal[x]) {
          const weight = verticalSample.weight * horizontalSample.weight;
          const input = sampleOffset(horizontalSample.source, verticalSample.source, sourceWidth);
          const surfaceWeight = weight * source.albedo[input + 3] / 255;
          totalWeight += weight;
          visibleWeight += surfaceWeight;
          alpha += source.albedo[input + 3] * weight;
          for (let component = 0; component < 3; component += 1) {
            albedoLinear[component] += srgbToLinear[source.albedo[input + component]] * surfaceWeight;
            emissiveLinear[component] += srgbToLinear[source.emissive[input + component]] * surfaceWeight;
            material[component] += source.material[input + component] * surfaceWeight;
            normal[component] += (source.normal[input + component] / 127.5 - 1) * surfaceWeight;
          }
        }
      }

      for (let component = 0; component < 3; component += 1) {
        target.albedo[output + component] = visibleWeight > 0 ? linearToSrgbByte(albedoLinear[component] / visibleWeight) : 0;
        target.emissive[output + component] = visibleWeight > 0 ? linearToSrgbByte(emissiveLinear[component] / visibleWeight) : 0;
        target.material[output + component] = visibleWeight > 0 ? averageByte(material[component], visibleWeight) : 0;
      }
      const normalLength = Math.hypot(normal[0], normal[1], normal[2]);
      const normalized = normalLength > 1e-8
        ? normal.map((component) => component / normalLength)
        : [0, 0, 1];
      for (let component = 0; component < 3; component += 1) {
        target.normal[output + component] = Math.round((normalized[component] * 0.5 + 0.5) * 255);
      }
      target.albedo[output + 3] = averageByte(alpha, totalWeight);
    }
  }
  return target;
}

function passingAlphaCount(bytes, cutoffByte, scale) {
  let count = 0;
  for (let offset = 3; offset < bytes.byteLength; offset += 4) {
    if (Math.round(Math.min(255, bytes[offset] * scale)) >= cutoffByte) count += 1;
  }
  return count;
}

function coverageScale(bytes, referenceCoverage, cutoff) {
  const pixelCount = bytes.byteLength / 4;
  const targetCount = referenceCoverage > 0
    ? Math.max(1, Math.round(referenceCoverage * pixelCount))
    : 0;
  const cutoffByte = Math.ceil(cutoff * 255);
  const alphaValues = new Set();
  let maximumAlpha = 0;
  for (let offset = 3; offset < bytes.byteLength; offset += 4) {
    const alpha = bytes[offset];
    maximumAlpha = Math.max(maximumAlpha, alpha);
    if (alpha > 0) alphaValues.add(alpha);
  }
  const candidates = [1];
  if (maximumAlpha > 0) candidates.push((cutoffByte - 0.500001) / maximumAlpha);
  for (const alpha of alphaValues) candidates.push((cutoffByte - 0.499999) / alpha);

  let bestScale = candidates[0];
  let bestDistance = Number.POSITIVE_INFINITY;
  let bestAdjustment = Number.POSITIVE_INFINITY;
  for (const scale of candidates) {
    const distance = Math.abs(passingAlphaCount(bytes, cutoffByte, scale) - targetCount);
    const adjustment = Math.abs(Math.log(Math.max(scale, Number.EPSILON)));
    if (distance < bestDistance || (distance === bestDistance && adjustment < bestAdjustment)) {
      bestScale = scale;
      bestDistance = distance;
      bestAdjustment = adjustment;
    }
  }
  return bestScale;
}

function alphaCoverage(bytes, cutoff) {
  const cutoffByte = Math.ceil(cutoff * 255);
  return passingAlphaCount(bytes, cutoffByte, 1) / (bytes.byteLength / 4);
}

function applyAlpha(layer, cutoff, referenceCoverage) {
  const scale = cutoff === null ? 1 : coverageScale(layer.albedo, referenceCoverage, cutoff);
  for (let offset = 3; offset < layer.albedo.byteLength; offset += 4) {
    const alpha = Math.round(Math.min(255, layer.albedo[offset] * scale));
    for (const channel of channelNames) layer[channel][offset] = alpha;
  }
}

function canonicalBaseLayer(channels, layerIndex) {
  const layer = Object.fromEntries(channelNames.map((channel) => [channel, Buffer.from(channels[channel][layerIndex])]));
  for (let offset = 3; offset < layer.albedo.byteLength; offset += 4) {
    for (const channel of channelNames.slice(1)) layer[channel][offset] = layer.albedo[offset];
  }
  return layer;
}

/**
 * Builds a complete top-to-bottom, layer-major PBR mip chain. Each returned
 * level keeps its layers separate so storage row order and artifact encoding
 * remain the caller's responsibility.
 */
export function buildPbrTextureArrayMipLevels({
  width,
  height,
  albedoLayers,
  normalLayers,
  materialLayers,
  emissiveLayers,
  mipmaps = true,
  alphaCutoffs,
}) {
  requireDimension(width, "Texture mip width");
  requireDimension(height, "Texture mip height");
  if (!Array.isArray(albedoLayers) || albedoLayers.length < 1) {
    throw new RangeError("Texture mip albedo must contain at least one layer");
  }
  if (typeof mipmaps !== "boolean") throw new TypeError("Texture mip mipmaps must be boolean");
  const layerCount = albedoLayers.length;
  const cutoffs = requireAlphaCutoffs(alphaCutoffs, layerCount);
  const byteLength = width * height * 4;
  if (!Number.isSafeInteger(byteLength)) throw new RangeError("Texture mip dimensions exceed the safe RGBA8 byte range");
  const channels = {
    albedo: requireLayers(albedoLayers, layerCount, byteLength, "albedo"),
    normal: requireLayers(normalLayers, layerCount, byteLength, "normal"),
    material: requireLayers(materialLayers, layerCount, byteLength, "material"),
    emissive: requireLayers(emissiveLayers, layerCount, byteLength, "emissive"),
  };
  const baseLayers = Array.from({length: layerCount}, (_value, layer) => canonicalBaseLayer(channels, layer));
  const referenceCoverage = baseLayers.map((layer, index) => cutoffs[index] === null
    ? null
    : alphaCoverage(layer.albedo, cutoffs[index]));
  const levels = [{level: 0, width, height, layers: baseLayers}];

  let sourceWidth = width;
  let sourceHeight = height;
  let sourceLayers = baseLayers;
  while (mipmaps && (sourceWidth > 1 || sourceHeight > 1)) {
    const targetWidth = Math.max(1, Math.floor(sourceWidth / 2));
    const targetHeight = Math.max(1, Math.floor(sourceHeight / 2));
    const targetLayers = sourceLayers.map((source, layerIndex) => {
      const target = downsampleLayer(source, sourceWidth, sourceHeight, targetWidth, targetHeight);
      applyAlpha(target, cutoffs[layerIndex], referenceCoverage[layerIndex]);
      return target;
    });
    levels.push({level: levels.length, width: targetWidth, height: targetHeight, layers: targetLayers});
    sourceWidth = targetWidth;
    sourceHeight = targetHeight;
    sourceLayers = targetLayers;
  }
  return levels;
}
