import {Color3} from "@babylonjs/core/Maths/math.color.js";
import {PBRMaterial} from "@babylonjs/core/Materials/PBR/pbrMaterial.js";
import {Material} from "@babylonjs/core/Materials/material.js";
import {SharedShadowDepthWrapper} from "./shared-shadow-depth-wrapper.mjs";
import {VoxelTextureArrayPlugin} from "./texture-bank.mjs";

// Resource recipes are resolved once per material pipeline. Upload validation
// and PBR construction consume the same result, including animation layer ownership.
export class VoxelMaterialLibrary {
  constructor(scene, options, textureBanks, climateTintField) {
    this.scene = scene;
    this.textureBanks = textureBanks;
    this.climateTintField = climateTintField;
    this.pipelines = new Map();
    this.animationClockMs = 0;
    this.materialDefinitions = new Map(options.materials.map((definition) => [definition.key, definition]));
    this.textureDefinitions = new Map(options.textures.map((definition) => [definition.key, definition]));
    this.animationDefinitions = new Map(options.animations.map((definition) => [definition.key, definition]));
    this.textureLayerAlphaCutoffs = new Map();
    for (const texture of options.textures) {
      let layers = this.textureLayerAlphaCutoffs.get(texture.bankKey);
      if (layers === undefined) {
        layers = new Map();
        this.textureLayerAlphaCutoffs.set(texture.bankKey, layers);
      }
      for (const variant of texture.variants) {
        if (layers.has(variant.layer)) throw new Error("Voxel texture array layer is assigned more than once: " + texture.bankKey + ":" + variant.layer);
        layers.set(variant.layer, texture.alphaCutoff);
      }
    }
    this.materials = new Map();
    this.animatedMaterials = [];
  }

  resolvePipeline(batch) {
    if (typeof batch !== "object" || batch === null) throw new TypeError("Chunk mesh batch must be a record");
    if (typeof batch.pipelineKey !== "string" || batch.pipelineKey.length === 0) throw new TypeError("Chunk mesh pipeline key must be non-empty text");
    if (typeof batch.bankKey !== "string" || batch.bankKey.length === 0) throw new TypeError("Chunk mesh bank key must be non-empty text");
    if (typeof batch.materialKey !== "string" || batch.materialKey.length === 0) throw new TypeError("Chunk mesh material key must be non-empty text");
    if (batch.animationKey != null && (typeof batch.animationKey !== "string" || batch.animationKey.length === 0)) {
      throw new TypeError("Chunk mesh animation key must be non-empty text or null");
    }
    if (!["opaque", "cutout", "translucent"].includes(batch.layer)) throw new TypeError("Chunk mesh render layer is invalid");
    const expectedKey = batch.layer + "|" + batch.bankKey + "|" + batch.materialKey + "|" + (batch.animationKey ?? "-");
    if (batch.pipelineKey !== expectedKey) throw new Error("Voxel material pipeline key does not match its batch contract");
    const existing = this.pipelines.get(expectedKey);
    if (existing !== undefined) return existing;
    const materialDefinition = this.materialDefinitions.get(batch.materialKey);
    if (materialDefinition === undefined) throw new Error("Unknown voxel material " + batch.materialKey);
    const textureBank = this.textureBanks.get(batch.bankKey);
    if (textureBank === undefined) throw new Error("Unknown voxel texture bank " + batch.bankKey);
    if (textureBank.role !== batch.layer && !(batch.layer === "translucent" && textureBank.role === "fluid")) {
      throw new Error("Voxel texture bank " + batch.bankKey + " cannot serve render layer " + batch.layer);
    }
    if (!["none", "solid", "water"].includes(materialDefinition.precipitationSurface)) {
      throw new RangeError("Voxel material precipitation surface must be none, solid, or water");
    }
    let animationBaseLayer = null;
    let animation = null;
    const frames = [];
    if (batch.animationKey != null) {
      animation = this.animationDefinitions.get(batch.animationKey);
      if (animation === undefined) throw new Error("Unknown voxel animation " + batch.animationKey);
      for (const [frameIndex, key] of animation.frames.entries()) {
        const texture = this.textureDefinitions.get(key);
        if (texture === undefined || texture.variants.length !== 1) throw new Error("Animated voxel texture must have exactly one variant: " + key);
        if (texture.bankKey !== batch.bankKey) throw new Error("Voxel animation " + batch.animationKey + " crosses texture banks");
        if (batch.layer === "cutout" && texture.alphaCutoff !== materialDefinition.alphaCutoff) {
          throw new Error("Voxel animation " + batch.animationKey + " frame " + key + " was filtered for a different material alpha cutoff");
        }
        if (frameIndex === 0) animationBaseLayer = texture.variants[0].layer;
        frames.push({layerOffset: texture.variants[0].layer - animationBaseLayer});
      }
    }
    const pipeline = {textureBank, materialDefinition, animationBaseLayer, animation, frames};
    this.pipelines.set(expectedKey, pipeline);
    return pipeline;
  }

  materialFor(batch) {
    const pipeline = this.resolvePipeline(batch);
    const key = batch.pipelineKey;
    const existing = this.materials.get(key);
    if (existing !== undefined) return existing;
    const {materialDefinition: definition, textureBank, animation, frames} = pipeline;
    const material = new PBRMaterial("material:" + key, this.scene);
    try {
      const texturePlugin = new VoxelTextureArrayPlugin(material, textureBank, this.climateTintField);
      material.albedoColor = Color3.White();
      material.ambientColor = new Color3(0.38, 0.4, 0.38);
      material.emissiveColor = Color3.Black();
      material.metallic = 1;
      material.roughness = 1;
      material.environmentIntensity = definition.environmentIntensity;
      material.clearCoat.isEnabled = definition.clearCoat > 0;
      material.clearCoat.intensity = definition.clearCoat;
      material.clearCoat.roughness = definition.clearCoatRoughness;
      material.unlit = definition.unlit;
      // OpenVoxel 的网格从外侧观察使用逆时针顶点绕序。Babylon 的右手场景会
      // 默认把 Mesh 设为顺时针正面，因此这里必须在材质边界显式对齐。
      material.sideOrientation = Material.CounterClockWiseSideOrientation;
      material.backFaceCulling = !definition.doubleSided;
      material.twoSidedLighting = definition.doubleSided;
      material.separateCullingPass = definition.doubleSided;
      if (batch.layer === "cutout") {
        material.transparencyMode = Material.MATERIAL_ALPHATEST;
        material.alphaCutOff = definition.alphaCutoff;
      } else if (batch.layer === "translucent") {
        material.transparencyMode = Material.MATERIAL_ALPHABLEND;
        material.alpha = definition.alpha;
      } else {
        material.transparencyMode = Material.MATERIAL_OPAQUE;
        material.alpha = 1;
      }
      if (batch.layer === "cutout" && definition.castsShadows) {
        material.shadowDepthWrapper = new SharedShadowDepthWrapper(material, this.scene);
      }
      if (animation !== null && frames.length > 1) {
        this.animatedMaterials.push({frameDurationMs: animation.frameDurationMs, frames, frameIndex: -1, plugin: texturePlugin});
      }
      this.materials.set(key, material);
      return material;
    } catch (error) {
      material.shadowDepthWrapper?.dispose();
      material.shadowDepthWrapper = null;
      material.dispose(true, false);
      throw error;
    }
  }

  update(deltaMs) {
    if (this.animatedMaterials.length === 0) return;
    this.animationClockMs += deltaMs;
    for (const animation of this.animatedMaterials) {
      const frameIndex = Math.floor(this.animationClockMs / animation.frameDurationMs) % animation.frames.length;
      if (frameIndex === animation.frameIndex) continue;
      animation.frameIndex = frameIndex;
      const frame = animation.frames[frameIndex];
      animation.plugin.animationLayerOffset = frame.layerOffset;
    }
  }

  dispose() {
    this.animatedMaterials.length = 0;
    for (const material of this.materials.values()) {
      material.shadowDepthWrapper?.dispose();
      material.shadowDepthWrapper = null;
      material.dispose(true, false);
    }
    this.materials.clear();
    this.pipelines.clear();
  }
}
