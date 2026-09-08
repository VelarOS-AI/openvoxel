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

function uploadTextureMipLevels(scene, texture, levels, label) {
  const engine = scene.getEngine();
  const internalTexture = texture.getInternalTexture();
  const gl = engine._gl;
  if (internalTexture == null || gl == null || typeof gl.texImage3D !== "function" || typeof engine._bindTextureDirectly !== "function") {
    throw new Error(label + " cannot access the pinned Babylon WebGL 2 texture upload boundary");
  }
  const target = gl.TEXTURE_2D_ARRAY;
  engine._bindTextureDirectly(target, internalTexture, true);
  try {
    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, 0);
    gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);
    for (const [mipLevel, level] of levels.entries()) {
      gl.texImage3D(target, mipLevel, gl.RGBA8, level.width, level.height, texture.depth, 0, gl.RGBA, gl.UNSIGNED_BYTE, level.data);
    }
  } finally {
    engine._bindTextureDirectly(target, null, true);
  }
  internalTexture.useMipMaps = levels.length > 1;
  internalTexture.generateMipMaps = false;
  internalTexture.mipLevelCount = levels.length;
  const samplingMode = levels.length > 1 ? Texture.NEAREST_NEAREST_MIPLINEAR : Texture.NEAREST_SAMPLINGMODE;
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
    const texture = RawTexture2DArray.CreateRGBATexture(
      levels[0].data,
      base.width,
      base.height,
      definition.layerCount,
      scene,
      false,
      false,
      Texture.NEAREST_SAMPLINGMODE,
    );
    textures.push(texture);
    texture.name = "texture-bank:" + definition.key + ":" + label;
    uploadTextureMipLevels(scene, texture, levels, texture.name);
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
      uploadTextureMipLevels(scene, normal, decodedLevels.map((level) => ({width: level.width, height: level.height, data: level.normal})), normal.name);
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
  constructor(material, textureBank, climateField = null) {
    super(material, "OpenVoxelTextureArray", 200, {}, true, false, true);
    this.registerForExtraEvents = true;
    this.textureBank = textureBank;
    this.climateField = climateField;
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
    return this.textureBank.albedo.isReady()
      && this.textureBank.normal.isReady()
      && this.textureBank.material.isReady()
      && this.textureBank.emissive.isReady();
  }

  prepareDefinesBeforeAttributes(defines) {
    defines._needUVs = true;
    defines.MAINUV1 = true;
  }

  getAttributes(attributes) {
    attributes.push("textureLayer", "tintRole");
  }

  getSamplers(samplers) {
    samplers.push("ovAlbedoSampler", "ovNormalSampler", "ovMaterialSampler", "ovEmissiveSampler");
  }

  getUniforms() {
    return {ubo: [
      {name: "ovAnimationLayerOffset", size: 1, type: "float"},
      {name: "ovClimateBounds", size: 4, type: "vec4"},
      ...Array.from({length: 8}, (_, index) => ({name: "ovClimate" + index, size: 4, type: "vec4"})),
    ]};
  }

  bindForSubMesh(uniformBuffer) {
    uniformBuffer.updateFloat("ovAnimationLayerOffset", this.animationLayerOffset);
    uniformBuffer.setTexture("ovAlbedoSampler", this.textureBank.albedo);
    uniformBuffer.setTexture("ovNormalSampler", this.textureBank.normal);
    uniformBuffer.setTexture("ovMaterialSampler", this.textureBank.material);
    uniformBuffer.setTexture("ovEmissiveSampler", this.textureBank.emissive);
  }

  hardBindForSubMesh(uniformBuffer, _scene, _engine, subMesh) {
    uniformBuffer.updateFloat("ovAnimationLayerOffset", this.animationLayerOffset);
    const mesh = subMesh.getRenderingMesh();
    if (this.climateField === null || !mesh.hasClimateTint) return;
    const climate = this.climateField.forPosition(mesh.position);
    uniformBuffer.updateFloat4("ovClimateBounds", ...climate.bounds);
    for (let index = 0; index < 8; index += 1) uniformBuffer.updateFloat4("ovClimate" + index, ...climate.corners[index]);
  }

  hasTexture(texture) {
    return texture === this.textureBank.albedo
      || texture === this.textureBank.normal
      || texture === this.textureBank.material
      || texture === this.textureBank.emissive;
  }

  getActiveTextures(textures) {
    textures.push(this.textureBank.albedo, this.textureBank.normal, this.textureBank.material, this.textureBank.emissive);
  }

  getCustomCode(shaderType) {
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
uniform float ovAnimationLayerOffset;
uniform vec4 ovClimateBounds;
${Array.from({length: 8}, (_, index) => "uniform vec4 ovClimate" + index + ";").join("\n")}
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
ovNormalSample = texture(ovNormalSampler, ovTextureCoordinate);
ovMaterialSample = texture(ovMaterialSampler, ovTextureCoordinate);
ovEmissiveSample = texture(ovEmissiveSampler, ovTextureCoordinate);`,
      CUSTOM_FRAGMENT_UPDATE_ALBEDO: `
vec4 ovClimateSample = vec4(18.0, 0.6, 0.0, 0.0);
if (ovTintRole > 0.5 && ovClimateBounds.w > 0.0) {
  vec3 amount = clamp((vPositionW - ovClimateBounds.xyz) / ovClimateBounds.w, 0.0, 1.0);
  ovClimateSample = mix(
    mix(mix(ovClimate0, ovClimate1, amount.x), mix(ovClimate2, ovClimate3, amount.x), amount.z),
    mix(mix(ovClimate4, ovClimate5, amount.x), mix(ovClimate6, ovClimate7, amount.x), amount.z),
    amount.y);
}
surfaceAlbedo *= toLinearSpace(ovApplyClimateTint(ovAlbedoSample.rgb, ovTintRole, ovClimateSample));
alpha *= ovAlbedoSample.a;`,
      CUSTOM_FRAGMENT_UPDATE_METALLICROUGHNESS: `
metallicRoughness.r = ovMaterialSample.b;
metallicRoughness.g = ovMaterialSample.g;`,
      CUSTOM_FRAGMENT_BEFORE_LIGHTS: `
vec2 ovNormalUv = gl_FrontFacing ? ovTextureUv : -ovTextureUv;
normalW = normalize(ovCotangentFrame(normalW, vPositionW, ovNormalUv) * (ovNormalSample.xyz * 2.0 - 1.0));`,
      "!(aoOut=ambientOcclusionBlock\\([\\s\\S]*?\\);)": `$1
aoOut.ambientOcclusionColor *= vec3(ovMaterialSample.r);`,
      CUSTOM_FRAGMENT_BEFORE_FINALCOLORCOMPOSITION: `
finalEmissive += toLinearSpace(ovEmissiveSample.rgb);`,
    };
  }
}
