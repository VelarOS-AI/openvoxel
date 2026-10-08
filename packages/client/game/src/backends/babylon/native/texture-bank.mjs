import {MaterialPluginBase} from "@babylonjs/core/Materials/materialPluginBase.js";
import {RawTexture2DArray} from "@babylonjs/core/Materials/Textures/rawTexture2DArray.js";
import {Texture} from "@babylonjs/core/Materials/Textures/texture.js";
import {climateTintShader} from "./climate-tint.mjs";

const maximumTextureBankChannelBytes = 16 * 1024 * 1024;
const maximumClientTextureResidentBytes = 128 * 1024 * 1024;

function requireInteger(value, minimum, maximum, label) {
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
    throw new RangeError(label + " must be an integer from " + minimum + " through " + maximum);
  }
  return value;
}

export function requireTextureBankDefinitions(value) {
  if (!Array.isArray(value) || value.length === 0) throw new TypeError("Voxel surface texture banks must be a non-empty list");
  const keys = new Set();
  let estimatedResidentBytes = 0;
  for (const definition of value) {
    if (typeof definition !== "object" || definition === null) throw new TypeError("Voxel surface texture bank must be a record");
    if (typeof definition.key !== "string" || definition.key.length === 0) throw new TypeError("Voxel surface texture bank key must be a non-empty string");
    if (keys.has(definition.key)) throw new Error("Voxel surface repeats texture bank " + definition.key);
    keys.add(definition.key);
    if (!["opaque", "cutout", "translucent", "fluid"].includes(definition.role)) throw new TypeError("Voxel surface texture bank has an invalid role: " + definition.key);
    if (definition.storage !== "texture_2d_array") throw new TypeError("Voxel surface texture bank uses unsupported storage: " + definition.key);
    const layerCount = requireInteger(definition.layerCount, 1, 2048, "Texture bank layer count");
    if (!Array.isArray(definition.levels) || definition.levels.length < 1 || definition.levels.length > 9) {
      throw new RangeError("Voxel surface texture bank mip level count is invalid: " + definition.key);
    }
    let previousWidth = 0;
    let previousHeight = 0;
    let channelBytes = 0;
    let encodedCharacters = 0;
    for (const [levelIndex, level] of definition.levels.entries()) {
      if (typeof level !== "object" || level === null) throw new TypeError("Voxel surface texture mip level must be a record");
      const width = requireInteger(level.width, 1, 256, "Texture bank mip width");
      const height = requireInteger(level.height, 1, 256, "Texture bank mip height");
      if (levelIndex > 0 && previousWidth === 1 && previousHeight === 1) {
        throw new RangeError("Voxel surface texture bank has a mip level after 1x1: " + definition.key);
      }
      if (levelIndex > 0 && (width !== Math.max(1, Math.floor(previousWidth / 2)) || height !== Math.max(1, Math.floor(previousHeight / 2)))) {
        throw new RangeError("Voxel surface texture bank mip dimensions are invalid: " + definition.key);
      }
      previousWidth = width;
      previousHeight = height;
      const levelBytes = width * height * layerCount * 4;
      channelBytes += levelBytes;
      const encodedLength = Math.floor((levelBytes + 2) / 3) * 4;
      encodedCharacters += encodedLength * 4;
      if (channelBytes > maximumTextureBankChannelBytes) {
        throw new RangeError("Voxel surface texture bank exceeds the 16 MiB per-channel limit: " + definition.key);
      }
      const currentResidentBytes = channelBytes * 4 * 2 + encodedCharacters * 2;
      if (estimatedResidentBytes + currentResidentBytes > maximumClientTextureResidentBytes) {
        throw new RangeError("Voxel surface texture banks exceed the 128 MiB estimated resident texture limit");
      }
      const remainder = levelBytes % 3;
      const pattern = remainder === 0
        ? /^[A-Za-z0-9+/]+$/u
        : remainder === 1 ? /^[A-Za-z0-9+/]+==$/u : /^[A-Za-z0-9+/]+=$/u;
      for (const [label, data] of [
        ["albedo", level.albedoData],
        ["normal", level.normalData],
        ["material", level.materialData],
        ["emissive", level.emissiveData],
      ]) {
        if (typeof data !== "string" || data.length !== encodedLength || !pattern.test(data)) {
          throw new TypeError("Voxel surface texture bank " + definition.key + " mip " + levelIndex + " " + label + " map must be complete RGBA8 base64 data");
        }
      }
    }
    if (definition.levels.length > 1 && (previousWidth !== 1 || previousHeight !== 1)) {
      throw new RangeError("Voxel surface texture bank mip chain is incomplete: " + definition.key);
    }
    const rgbaBytes = channelBytes * 4;
    estimatedResidentBytes += rgbaBytes * 2 + encodedCharacters * 2;
  }
  if (estimatedResidentBytes > maximumClientTextureResidentBytes) {
    throw new RangeError("Voxel surface texture banks exceed the 128 MiB estimated resident texture limit");
  }
  return value;
}

function decodeRgba8(data, expectedLength, label) {
  let bytes;
  try {
    bytes = Uint8Array.fromBase64(data);
  } catch (error) {
    throw new TypeError(label + " is not valid base64", {cause: error});
  }
  if (bytes.byteLength !== expectedLength) throw new RangeError(label + " byte length does not match its texture array contract");
  return bytes;
}

export function uploadTextureMipLevels(scene, texture, levels, label, smooth = false) {
  const engine = scene.getEngine();
  const internalTexture = texture.getInternalTexture();
  if (internalTexture == null) throw new Error(label + " has no allocated texture");
  internalTexture.generateMipMaps = false;
  // Babylon 9.23's WebGL array updater ignores the mip argument; its WebGPU
  // updater supports it. Both paths upload the same authored alpha-safe mips.
  if (engine.isWebGPU) {
    for (const [mipLevel, level] of levels.entries()) texture.updateMipLevel(level.data, mipLevel);
    // InternalTexture._swapAndDie rebuilds the view from generateMipMaps, which
    // is false for authored mips. Expose the full chain after initial upload and
    // device restore; otherwise distant surfaces silently sample only level 0.
    const hardware = internalTexture._hardwareTexture;
    hardware.createView({label: label + ":authored-mips", format: hardware.format,
      dimension: "2d-array", baseMipLevel: 0, mipLevelCount: levels.length,
      baseArrayLayer: 0, arrayLayerCount: texture.depth, aspect: "all"});
  } else {
    const gl = engine._gl;
    if (gl == null || typeof gl.texImage3D !== "function" || typeof engine._bindTextureDirectly !== "function") {
      throw new Error(label + " cannot access the pinned Babylon WebGL 2 texture upload boundary");
    }
    engine._bindTextureDirectly(gl.TEXTURE_2D_ARRAY, internalTexture, true);
    try {
      gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, 0);
      gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);
      for (const [mipLevel, level] of levels.entries()) {
        gl.texImage3D(gl.TEXTURE_2D_ARRAY, mipLevel, gl.RGBA8, level.width, level.height, texture.depth, 0, gl.RGBA, gl.UNSIGNED_BYTE, level.data);
      }
    } finally {
      engine._bindTextureDirectly(gl.TEXTURE_2D_ARRAY, null, true);
    }
  }
  internalTexture.useMipMaps = levels.length > 1;
  internalTexture.generateMipMaps = false;
  internalTexture.mipLevelCount = levels.length;
  // Preserve pixel-art magnification while filtering minified terrain inside
  // each mip. Nearest minification aliases into moving diagonal bands.
  const samplingMode = smooth
    ? Texture.TRILINEAR_SAMPLINGMODE
    : levels.length > 1 ? Texture.NEAREST_LINEAR_MIPLINEAR : Texture.NEAREST_SAMPLINGMODE;
  engine.updateTextureSamplingMode(samplingMode, internalTexture, false);
}

export function loadTextureBank(scene, definition, maximumLayers) {
  if (definition.layerCount > maximumLayers) {
    throw new RangeError("Texture bank " + definition.key + " exceeds this GPU's texture array layer limit of " + maximumLayers);
  }
  const decodedLevels = definition.levels.map((level, mipLevel) => {
    const byteLength = level.width * level.height * definition.layerCount * 4;
    return {
      width: level.width,
      height: level.height,
      albedo: decodeRgba8(level.albedoData, byteLength, "Texture bank " + definition.key + " mip " + mipLevel + " albedo"),
      normal: decodeRgba8(level.normalData, byteLength, "Texture bank " + definition.key + " mip " + mipLevel + " normal"),
      material: decodeRgba8(level.materialData, byteLength, "Texture bank " + definition.key + " mip " + mipLevel + " material"),
      emissive: decodeRgba8(level.emissiveData, byteLength, "Texture bank " + definition.key + " mip " + mipLevel + " emissive"),
    };
  });
  const base = decodedLevels[0];
  const textures = [];
  const create = (channel, label) => {
    const levels = decodedLevels.map((level) => ({width: level.width, height: level.height, data: level[channel]}));
    const smooth = definition.role === "fluid" && channel === "normal";
    const texture = new RawTexture2DArray(
      null,
      base.width,
      base.height,
      definition.layerCount,
      5,
      scene,
      scene.getEngine().isWebGPU && levels.length > 1,
      false,
      smooth ? Texture.TRILINEAR_SAMPLINGMODE : Texture.NEAREST_SAMPLINGMODE,
      0, 0, levels.length,
    );
    textures.push(texture);
    texture.name = "texture-bank:" + definition.key + ":" + label;
    uploadTextureMipLevels(scene, texture, levels, texture.name, smooth);
    texture.wrapU = Texture.WRAP_ADDRESSMODE;
    texture.wrapV = Texture.WRAP_ADDRESSMODE;
    texture.anisotropicFilteringLevel = 1;
    return texture;
  };
  try {
    const albedo = create("albedo", "albedo");
    const normal = create("normal", "normal");
    const material = create("material", "material");
    const emissive = create("emissive", "emissive");
    for (const [label, texture] of [["albedo", albedo], ["normal", normal], ["material", material], ["emissive", emissive]]) {
      const size = texture.getSize();
      if (size.width !== base.width || size.height !== base.height) {
        throw new Error("Texture bank " + definition.key + " " + label + " map dimensions do not match its contract");
      }
      if (texture.depth !== definition.layerCount) throw new Error("Texture bank " + definition.key + " " + label + " layer count does not match its contract");
    }
    const restore = () => {
      uploadTextureMipLevels(scene, albedo, decodedLevels.map((level) => ({width: level.width, height: level.height, data: level.albedo})), albedo.name);
      uploadTextureMipLevels(scene, normal, decodedLevels.map((level) => ({width: level.width, height: level.height, data: level.normal})), normal.name, definition.role === "fluid");
      uploadTextureMipLevels(scene, material, decodedLevels.map((level) => ({width: level.width, height: level.height, data: level.material})), material.name);
      uploadTextureMipLevels(scene, emissive, decodedLevels.map((level) => ({width: level.width, height: level.height, data: level.emissive})), emissive.name);
    };
    return {key: definition.key, role: definition.role, storage: definition.storage, layerCount: definition.layerCount, albedo, normal, material, emissive, restore};
  } catch (error) {
    for (const texture of textures) texture.dispose();
    throw error;
  }
}


export class VoxelTextureArrayPlugin extends MaterialPluginBase {
  constructor(material, textureBank, climateField = null, {neutralSurface = false, atmosphere = null, grassPlant = false, terrainSurface = false} = {}) {
    super(material, "OpenVoxelTextureArray", 200, {}, true, false, true);
    if (typeof neutralSurface !== "boolean") throw new TypeError("Voxel texture neutralSurface must be boolean");
    this.registerForExtraEvents = true;
    this.textureBank = textureBank;
    this.climateField = climateField;
    this.neutralSurface = neutralSurface;
    this.atmosphere = atmosphere;
    this.grassPlant = grassPlant;
    this.terrainSurface = terrainSurface;
    this.animationLayerOffset = 0;
    this._enable(true);
  }

  getClassName() {
    return "OpenVoxelTextureArrayPlugin";
  }

  isCompatible(shaderLanguage) {
    return shaderLanguage === 0;
  }

  isReadyForSubMesh() {
    if (this.neutralSurface) return true;
    return this.textureBank.albedo.isReady()
      && this.textureBank.normal.isReady()
      && this.textureBank.material.isReady()
      && this.textureBank.emissive.isReady();
  }

  prepareDefinesBeforeAttributes(defines) {
    if (this.neutralSurface) return;
    defines._needUVs = true;
    defines.MAINUV1 = true;
  }

  getAttributes(attributes) {
    if (this.neutralSurface) attributes.push("tintRole");
    else attributes.push("textureLayer", "tintRole");
  }

  getSamplers(samplers) {
    if (this.neutralSurface) return;
    samplers.push("ovAlbedoSampler", "ovNormalSampler", "ovMaterialSampler", "ovEmissiveSampler");
  }

  getUniforms() {
    const ubo = [
      {name: "ovClimateBounds", size: 4, type: "vec4"},
      ...Array.from({length: 8}, (_, index) => ({name: "ovClimate" + index, size: 4, type: "vec4"})),
    ];
    if (!this.neutralSurface) ubo.unshift({name: "ovAnimationLayerOffset", size: 1, type: "float"}, {name: "ovSurfaceWetness", size: 1, type: "float"});
    return {ubo, fragment: ubo.map(uniform => `uniform ${uniform.type} ${uniform.name};`).join("\n")};
  }

  bindForSubMesh(uniformBuffer, _scene, engine) {
    if (this.neutralSurface) return;
    uniformBuffer.updateFloat("ovSurfaceWetness", this.atmosphere?.wetness ?? 0);
    uniformBuffer.updateFloat("ovAnimationLayerOffset", this.animationLayerOffset);
    const context = engine?.isWebGPU ? engine._currentMaterialContext : null;
    this.bindBankTexture(uniformBuffer, context, "ovAlbedoSampler", this.textureBank.albedo);
    this.bindBankTexture(uniformBuffer, context, "ovNormalSampler", this.textureBank.normal);
    this.bindBankTexture(uniformBuffer, context, "ovMaterialSampler", this.textureBank.material);
    this.bindBankTexture(uniformBuffer, context, "ovEmissiveSampler", this.textureBank.emissive);
  }

  bindBankTexture(buffer, context, name, texture) {
    // Authored texture banks own immutable filtering/wrap recipes. WebGPU draw
    // contexts retain these bindings; there is no video/delayed texture update
    // to perform per draw. A new context or restored internal texture rebinds.
    if (context && context.textures[name]?.texture === texture.getInternalTexture()) return;
    buffer.setTexture(name, texture);
  }

  hardBindForSubMesh(uniformBuffer, _scene, _engine, subMesh) {
    if (!this.neutralSurface) uniformBuffer.updateFloat("ovAnimationLayerOffset", this.animationLayerOffset);
    const mesh = subMesh.getRenderingMesh();
    if (this.climateField === null || !mesh.hasClimateTint) return;
    const cache = uniformBuffer._valueCache;
    const revision = this.climateField.revision;
    const cached = cache?.openVoxelClimate;
    if (revision !== undefined && cached?.meshId === mesh.uniqueId && cached.revision === revision) return;
    const climate = this.climateField.forPosition(mesh.position);
    uniformBuffer.updateFloat4("ovClimateBounds", ...climate.bounds);
    for (let index = 0; index < 8; index += 1) uniformBuffer.updateFloat4("ovClimate" + index, ...climate.corners[index]);
    if (cache) cache.openVoxelClimate = {meshId: mesh.uniqueId, revision};
  }

  hasTexture(texture) {
    if (this.neutralSurface) return false;
    return texture === this.textureBank.albedo
      || texture === this.textureBank.normal
      || texture === this.textureBank.material
      || texture === this.textureBank.emissive;
  }

  getActiveTextures(textures) {
    if (this.neutralSurface) return;
    textures.push(this.textureBank.albedo, this.textureBank.normal, this.textureBank.material, this.textureBank.emissive);
  }

  getCustomCode(shaderType) {
    if (this.neutralSurface) {
      if (shaderType === "vertex") {
        return {
          CUSTOM_VERTEX_DEFINITIONS: `
attribute float tintRole;
varying float ovTintRole;`,
          CUSTOM_VERTEX_MAIN_END: `
ovTintRole = tintRole;`,
        };
      }
      if (shaderType !== "fragment") return null;
      return {
        CUSTOM_FRAGMENT_DEFINITIONS: `
varying float ovTintRole;
${climateTintShader}`,
        CUSTOM_FRAGMENT_UPDATE_ALBEDO: `
vec4 ovClimateSample = vec4(18.0, 0.6, 0.375, 0.0);
if (ovTintRole > 0.5 && ovClimateBounds.w > 0.0) {
  vec3 amount = clamp((vPositionW - ovClimateBounds.xyz) / ovClimateBounds.w, 0.0, 1.0);
  ovClimateSample = mix(
    mix(mix(ovClimate0, ovClimate1, amount.x), mix(ovClimate2, ovClimate3, amount.x), amount.z),
    mix(mix(ovClimate4, ovClimate5, amount.x), mix(ovClimate6, ovClimate7, amount.x), amount.z),
    amount.y);
}
surfaceAlbedo *= toLinearSpace(ovApplyClimateTint(vec3(1.0), ovTintRole, ovClimateSample, vPositionW, 0.0));`,
      };
    }
    if (shaderType === "vertex") {
      return {
        CUSTOM_VERTEX_DEFINITIONS: `
attribute float textureLayer;
attribute float tintRole;
varying vec2 ovTextureUv;
varying float ovTextureLayer;
varying float ovTintRole;`,
        CUSTOM_VERTEX_MAIN_END: `
ovTextureUv = uv;
ovTextureLayer = textureLayer;
ovTintRole = tintRole;`,
      };
    }
    if (shaderType !== "fragment") return null;
    return {
      CUSTOM_FRAGMENT_DEFINITIONS: `
varying vec2 ovTextureUv;
varying float ovTextureLayer;
varying float ovTintRole;
precision highp sampler2DArray;
uniform sampler2DArray ovAlbedoSampler;
uniform sampler2DArray ovNormalSampler;
uniform sampler2DArray ovMaterialSampler;
uniform sampler2DArray ovEmissiveSampler;
${climateTintShader}
vec4 ovAlbedoSample;
vec4 ovNormalSample;
vec4 ovMaterialSample;
vec4 ovEmissiveSample;
mat3 ovCotangentFrame(vec3 normal, vec3 position, vec2 textureUv) {
  vec3 positionDx = dFdx(position);
  vec3 positionDy = dFdy(position);
  vec2 uvDx = dFdx(textureUv);
  vec2 uvDy = dFdy(textureUv);
  vec3 positionDyPerpendicular = cross(positionDy, normal);
  vec3 positionDxPerpendicular = cross(normal, positionDx);
  vec3 tangent = positionDyPerpendicular * uvDx.x + positionDxPerpendicular * uvDy.x;
  vec3 bitangent = positionDyPerpendicular * uvDx.y + positionDxPerpendicular * uvDy.y;
  float determinant = max(dot(tangent, tangent), dot(bitangent, bitangent));
  float inverseMaximum = determinant == 0.0 ? 0.0 : inversesqrt(determinant);
  return mat3(tangent * inverseMaximum, bitangent * inverseMaximum, normal);
}`,
      CUSTOM_FRAGMENT_MAIN_BEGIN: `
float ovSampleLayer = floor(ovTextureLayer + ovAnimationLayerOffset + 0.5);
vec3 ovTextureCoordinate = vec3(ovTextureUv, ovSampleLayer);
ovAlbedoSample = texture(ovAlbedoSampler, ovTextureCoordinate);
ovNormalSample = vec4(0.5, 0.5, 1.0, 1.0);
ovMaterialSample = vec4(1.0, 1.0, 0.0, 1.0);
if (ovFineDetail > 0.0) {
  ovNormalSample = mix(ovNormalSample, texture(ovNormalSampler, ovTextureCoordinate), ovFineDetail);
  ovMaterialSample = mix(ovMaterialSample, texture(ovMaterialSampler, ovTextureCoordinate), ovFineDetail);
}
ovEmissiveSample = texture(ovEmissiveSampler, ovTextureCoordinate);`,
      CUSTOM_FRAGMENT_UPDATE_ALBEDO: `
vec4 ovClimateSample = vec4(18.0, 0.6, 0.375, 0.0);
if (ovTintRole > 0.5 && ovClimateBounds.w > 0.0) {
  vec3 amount = clamp((vPositionW - ovClimateBounds.xyz) / ovClimateBounds.w, 0.0, 1.0);
  ovClimateSample = mix(
    mix(mix(ovClimate0, ovClimate1, amount.x), mix(ovClimate2, ovClimate3, amount.x), amount.z),
    mix(mix(ovClimate4, ovClimate5, amount.x), mix(ovClimate6, ovClimate7, amount.x), amount.z),
    amount.y);
}
surfaceAlbedo *= toLinearSpace(ovApplyClimateTint(ovAlbedoSample.rgb, ovTintRole, ovClimateSample, vPositionW, ${this.grassPlant ? "1.0" : "0.0"}));
${this.terrainSurface ? `
// Continuous world-space weathering breaks up tiled surfaces without chunk seams.
float ovBroadPatch = sin(vPositionW.x * 0.047 + sin(vPositionW.z * 0.031) * 2.0) * sin(vPositionW.z * 0.057 - vPositionW.x * 0.018);
float ovFinePatch = sin(vPositionW.x * 0.29 + vPositionW.z * 0.17) * sin(vPositionW.z * 0.23 - vPositionW.x * 0.13);
float ovWeathering = 1.0 + ovBroadPatch * 0.12 + ovFinePatch * 0.035;
surfaceAlbedo *= ovWeathering;
` : ""}
surfaceAlbedo *= 1.0 - ovSurfaceWetness * clamp(vNormalW.y, 0.0, 1.0) * 0.16;
alpha *= ovAlbedoSample.a;`,
      CUSTOM_FRAGMENT_UPDATE_METALLICROUGHNESS: `
metallicRoughness.r = ovMaterialSample.b;
bool ovVegetationSurface = ovTintRole > 0.5 && !(ovTintRole > 2.5 && ovTintRole < 3.5);
float ovWetRoughness = ovVegetationSurface ? 0.86 : mix(0.42, 0.78, smoothstep(0.7, 0.95, ovMaterialSample.g));
metallicRoughness.g = mix(ovMaterialSample.g, min(ovWetRoughness, ovMaterialSample.g), ovSurfaceWetness * clamp(vNormalW.y, 0.0, 1.0));`,
      CUSTOM_FRAGMENT_BEFORE_LIGHTS: `
if (ovFineDetail > 0.0) {
  vec2 ovNormalUv = gl_FrontFacing ? ovTextureUv : -ovTextureUv;
  normalW = normalize(ovCotangentFrame(normalW, vPositionW, ovNormalUv) * (ovNormalSample.xyz * 2.0 - 1.0));
}`,
      "!(aoOut=ambientOcclusionBlock\\([\\s\\S]*?\\);)": `$1
aoOut.ambientOcclusionColor *= vec3(ovMaterialSample.r);`,
      CUSTOM_FRAGMENT_BEFORE_FINALCOLORCOMPOSITION: `
finalEmissive += toLinearSpace(ovEmissiveSample.rgb);`,
    };
  }
}
