import {clamp, requireNumber, requireRecord} from "./resource-pack-values.mjs";

const channelNames = ["albedo", "normal", "material", "emissive"];

function requireSurface(value, label) {
  const surface = requireRecord(value, label);
  let byteLength = null;
  const output = {};
  for (const channel of channelNames) {
    const bytes = surface[channel];
    if (!(bytes instanceof Uint8Array)) throw new TypeError(`${label} ${channel} must be RGBA8 bytes`);
    if (bytes.byteLength === 0 || bytes.byteLength % 4 !== 0) {
      throw new RangeError(`${label} ${channel} must contain complete RGBA8 pixels`);
    }
    if (byteLength == null) byteLength = bytes.byteLength;
    else if (bytes.byteLength !== byteLength) throw new RangeError(`${label} channels must have equal byte lengths`);
    output[channel] = Buffer.from(bytes);
  }
  for (const channel of channelNames.slice(1)) {
    for (let offset = 3; offset < byteLength; offset += 4) {
      if (output[channel][offset] !== output.albedo[offset]) {
        throw new RangeError(`${label} channels must share alpha at pixel ${Math.floor(offset / 4)}`);
      }
    }
  }
  return output;
}

function requireMask(value, byteLength) {
  if (value == null) return null;
  if (!(value instanceof Uint8Array)) throw new TypeError("Material layer mask must be RGBA8 bytes");
  if (value.byteLength !== byteLength) throw new RangeError("Material layer mask must match the surface byte length");
  return Buffer.from(value);
}

function srgbToLinear(value) {
  const normalized = value / 255;
  return normalized <= 0.04045 ? normalized / 12.92 : ((normalized + 0.055) / 1.055) ** 2.4;
}

function linearToSrgb(value) {
  const normalized = clamp(value);
  const encoded = normalized <= 0.0031308
    ? normalized * 12.92
    : 1.055 * normalized ** (1 / 2.4) - 0.055;
  return Math.round(clamp(encoded) * 255);
}

function blendAlbedo(base, layer, mode) {
  if (mode === "normal") return layer;
  if (mode === "multiply") return base * layer;
  if (mode === "overlay") return base < 0.5
    ? 2 * base * layer
    : 1 - 2 * (1 - base) * (1 - layer);
  throw new Error(`Unsupported material layer blend mode ${mode}`);
}

function decodeNormal(source, offset) {
  const x = source[offset] / 255 * 2 - 1;
  const y = source[offset + 1] / 255 * 2 - 1;
  const z = source[offset + 2] / 255 * 2 - 1;
  const length = Math.hypot(x, y, z);
  if (length < 1 / 64) throw new Error("Material layer contains a zero-length normal");
  return {x: x / length, y: y / length, z: z / length};
}

function normalized({x, y, z}, fallback) {
  const length = Math.hypot(x, y, z);
  return length < 1e-6 ? fallback : {x: x / length, y: y / length, z: z / length};
}

function whiteoutNormal(base, layer) {
  return normalized({
    x: base.x + layer.x,
    y: base.y + layer.y,
    z: base.z * layer.z,
  }, base);
}

function encodeNormal(target, offset, normal) {
  target[offset] = Math.round(clamp(normal.x * 0.5 + 0.5) * 255);
  target[offset + 1] = Math.round(clamp(normal.y * 0.5 + 0.5) * 255);
  target[offset + 2] = Math.round(clamp(normal.z * 0.5 + 0.5) * 255);
}

/**
 * Composites one complete PBR surface over another before mip generation.
 *
 * `blend` affects only albedo in linear-light space. The layer coverage is its
 * albedo alpha multiplied by the optional grayscale mask and opacity. Tangent
 * normals use normalized whiteout detail blending; material is R=AO,
 * G=roughness, B=metallic, where AO multiplies and the other properties lerp;
 * emissive energy adds in linear-light space and clamps. Every output channel
 * receives the same source-over alpha.
 */
export function composeMaterialLayer(baseValue, layerValue, {mask: rawMask = null, opacity: rawOpacity = 1, blend = "normal"} = {}) {
  const base = requireSurface(baseValue, "Base material surface");
  const layer = requireSurface(layerValue, "Material layer surface");
  if (base.albedo.byteLength !== layer.albedo.byteLength) {
    throw new RangeError("Material layer surface must match the base surface byte length");
  }
  const mask = requireMask(rawMask, base.albedo.byteLength);
  const opacity = requireNumber(rawOpacity, 0, 1, "Material layer opacity");
  if (!["normal", "multiply", "overlay"].includes(blend)) {
    throw new Error(`Unsupported material layer blend mode ${blend}`);
  }

  const output = Object.fromEntries(channelNames.map((channel) => [channel, Buffer.from(base[channel])]));
  for (let offset = 0; offset < output.albedo.byteLength; offset += 4) {
    const baseAlpha = base.albedo[offset + 3] / 255;
    const layerAlpha = layer.albedo[offset + 3] / 255;
    const maskValue = mask == null ? 1 : mask[offset] / 255;
    const coverage = layerAlpha * maskValue * opacity;
    if (coverage === 0) continue;

    const baseContribution = baseAlpha * (1 - coverage);
    const outputAlpha = coverage + baseContribution;
    const layerWeight = outputAlpha === 0 ? 0 : coverage / outputAlpha;

    for (let channel = 0; channel < 3; channel += 1) {
      const baseLinear = srgbToLinear(base.albedo[offset + channel]);
      const layerLinear = srgbToLinear(layer.albedo[offset + channel]);
      const blended = blendAlbedo(baseLinear, layerLinear, blend);
      const blendedSource = layerLinear + (blended - layerLinear) * baseAlpha;
      const premultiplied = blendedSource * coverage + baseLinear * baseContribution;
      output.albedo[offset + channel] = linearToSrgb(outputAlpha === 0 ? 0 : premultiplied / outputAlpha);
    }

    const baseNormal = decodeNormal(base.normal, offset);
    const layerNormal = decodeNormal(layer.normal, offset);
    const detailedNormal = whiteoutNormal(baseNormal, layerNormal);
    const blendedSourceNormal = normalized({
      x: layerNormal.x + (detailedNormal.x - layerNormal.x) * baseAlpha,
      y: layerNormal.y + (detailedNormal.y - layerNormal.y) * baseAlpha,
      z: layerNormal.z + (detailedNormal.z - layerNormal.z) * baseAlpha,
    }, layerNormal);
    const mixedNormal = normalized({
      x: baseNormal.x * baseContribution + blendedSourceNormal.x * coverage,
      y: baseNormal.y * baseContribution + blendedSourceNormal.y * coverage,
      z: baseNormal.z * baseContribution + blendedSourceNormal.z * coverage,
    }, blendedSourceNormal);
    encodeNormal(output.normal, offset, mixedNormal);

    const baseOcclusion = base.material[offset] / 255;
    const layerOcclusion = layer.material[offset] / 255;
    const blendedSourceOcclusion = layerOcclusion * (1 - baseAlpha + baseAlpha * baseOcclusion);
    const occlusion = (blendedSourceOcclusion * coverage + baseOcclusion * baseContribution) / outputAlpha;
    output.material[offset] = Math.round(clamp(occlusion) * 255);
    for (let channel = 1; channel < 3; channel += 1) {
      output.material[offset + channel] = Math.round(
        base.material[offset + channel]
          + (layer.material[offset + channel] - base.material[offset + channel]) * layerWeight,
      );
    }

    for (let channel = 0; channel < 3; channel += 1) {
      const baseEmission = srgbToLinear(base.emissive[offset + channel]);
      const layerEmission = srgbToLinear(layer.emissive[offset + channel]);
      output.emissive[offset + channel] = linearToSrgb(
        (baseEmission * baseAlpha + layerEmission * coverage) / outputAlpha,
      );
    }

    const alpha = Math.round(outputAlpha * 255);
    for (const channel of channelNames) output[channel][offset + 3] = alpha;
  }
  return output;
}
