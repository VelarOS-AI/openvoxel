import {Color3} from "@babylonjs/core/Maths/math.color.js";
import {StreamingPBRMaterial} from "./streaming-pbr-material.mjs";
import {SharedPluginUniforms} from "./shared-plugin-uniforms.mjs";
import {Material} from "@babylonjs/core/Materials/material.js";
import {SharedShadowDepthWrapper} from "./shared-shadow-depth-wrapper.mjs";
import {VoxelTextureArrayPlugin} from "./texture-bank.mjs";
import {VoxelWaterSurfacePlugin, WaterSurfaceRuntime} from "./water-surface.mjs";
import {TerrainFogPlugin} from "./terrain-fog.mjs";
import {VegetationMotionPlugin, VegetationMotionRuntime} from "./vegetation-motion.mjs";
import {VoxelLightingPlugin} from "./voxel-lighting.mjs";
import {DistanceDetailFramePlugin, DistanceDetailPlugin, stableShaderCode} from "./distance-detail.mjs";

function finiteNumber(value, minimum, maximum, label) {
  if (!Number.isFinite(value) || value < minimum || value > maximum) {
    throw new RangeError(label + " must be a finite number from " + minimum + " through " + maximum);
  }
  return value;
}

// Resource recipes are resolved once per material pipeline. Upload validation
// and PBR construction consume the same result, including animation layer ownership.
export class VoxelMaterialLibrary {
  constructor(scene, options, textureBanks, climateTintField, atmosphere, lighting = null) {
    this.scene = scene;
    this.textureBanks = textureBanks;
    this.climateTintField = climateTintField;
    this.atmosphere = atmosphere;
    this.lighting = lighting;
    this.sharedUniforms = new SharedPluginUniforms(scene);
    this.pipelines = new Map();
    this.animationClockMs = 0;
    this.waterSurfaceRuntime = new WaterSurfaceRuntime(scene);
    this.waterSurfaceRuntime.setEnvironmentFrame(options.environmentFrame ?? {windX: 0, windZ: 0});
    this.vegetationMotionRuntime = new VegetationMotionRuntime(options.environmentFrame ?? {windX: 0, windZ: 0});
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
    this.bindingBudget = {count: 0};
    this.disposed = false;
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
    if (!["standard", "water"].includes(materialDefinition.materialEffect)) {
      throw new RangeError("Voxel material effect must be standard or water");
    }
    let waterOptics = null;
    if (materialDefinition.materialEffect === "standard") {
      if (materialDefinition.waterOptics !== null) throw new Error("Standard voxel material cannot declare water optics");
    } else {
      if (materialDefinition.precipitationSurface !== "water") throw new Error("Water voxel material must use the water precipitation surface");
      if (batch.layer !== "translucent" || textureBank.role !== "fluid") throw new Error("Water voxel material must use a translucent fluid texture bank");
      const optics = materialDefinition.waterOptics;
      if (typeof optics !== "object" || optics === null || !Array.isArray(optics.waves) || optics.waves.length !== 2) {
        throw new TypeError("Water voxel material must declare exactly two normal waves");
      }
      const normalTextures = new Set();
      waterOptics = {
        indexOfRefraction: finiteNumber(optics.indexOfRefraction, 1, 2, "Water index of refraction"),
        roughness: finiteNumber(optics.roughness, 0, 1, "Water roughness"),
        normalStrength: finiteNumber(optics.normalStrength, 0, 1, "Water normal strength"),
        waves: optics.waves.map((wave, waveIndex) => {
          if (typeof wave !== "object" || wave === null || typeof wave.normalTexture !== "string" || wave.normalTexture.length === 0) {
            throw new TypeError("Water normal wave " + waveIndex + " must reference a texture");
          }
          if (normalTextures.has(wave.normalTexture)) throw new Error("Water normal waves must reference distinct textures");
          normalTextures.add(wave.normalTexture);
          const texture = this.textureDefinitions.get(wave.normalTexture);
          if (texture === undefined || texture.bankKey !== batch.bankKey || texture.variants.length !== 1) {
            throw new Error("Water normal texture must resolve to one layer in its fluid texture bank: " + wave.normalTexture);
          }
          const directionX = finiteNumber(wave.directionX, -1, 1, "Water wave direction x");
          const directionZ = finiteNumber(wave.directionZ, -1, 1, "Water wave direction z");
          const directionLength = Math.hypot(directionX, directionZ);
          if (directionLength < 0.999 || directionLength > 1.001) throw new RangeError("Water wave direction must be normalized");
          return {
            layer: texture.variants[0].layer,
            scale: finiteNumber(wave.scale, 0.001, 4, "Water wave scale"),
            speed: finiteNumber(wave.speed, 0, 4, "Water wave speed"),
            directionX,
            directionZ,
          };
        }),
      };
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
    const pipeline = {textureBank, materialDefinition, waterOptics, animationBaseLayer, animation, frames};
    this.pipelines.set(expectedKey, pipeline);
    return pipeline;
  }

  materialFor(batch, owner = null) {
    const pipeline = this.resolvePipeline(batch);
    const retained = this.scene.getEngine().isWebGPU;
    const key = batch.pipelineKey;
    const existing = this.materials.get(key);
    if (existing !== undefined) {
      if (retained && owner) existing.attachMesh(owner, this.bindingBudget);
      return existing;
    }
    const {materialDefinition: definition, waterOptics, textureBank, animation, frames} = pipeline;
    const isWater = definition.materialEffect === "water";
    const material = new StreamingPBRMaterial("material:" + key, this.scene, true);
    // No mesh owns this material yet. Batch recipe/plugin setup instead of
    // scanning all resident submeshes after every individual property setter.
    material.blockDirtyMechanism = true;
    try {
      const texturePlugin = stableShaderCode(new VoxelTextureArrayPlugin(material, textureBank, this.climateTintField, {
        terrainSurface: definition.key === "openvoxel:material/terrain", neutralSurface: isWater, atmosphere: this.atmosphere, grassPlant: definition.key === "openvoxel:material/cross",
      }));
      stableShaderCode(new DistanceDetailPlugin(material, definition.key));
      stableShaderCode(this.sharedUniforms.attach(new DistanceDetailFramePlugin(material, this.vegetationMotionRuntime), "detail"));
      stableShaderCode(new VoxelLightingPlugin(material, this.lighting));
      material.maxSimultaneousLights = 5;
      stableShaderCode(this.sharedUniforms.attach(new TerrainFogPlugin(material, this.atmosphere), "fog"));
      const vegetationMode = {"openvoxel:material/cross": "cross", "openvoxel:material/leaves": "leaves", "openvoxel:material/vine": "vine"}[definition.key];
      if (vegetationMode !== undefined) {
        stableShaderCode(this.sharedUniforms.attach(new VegetationMotionPlugin(material, vegetationMode, this.vegetationMotionRuntime), "vegetation"));
      }
      if (isWater) stableShaderCode(this.sharedUniforms.attach(new VoxelWaterSurfacePlugin(material, textureBank.normal, waterOptics, this.waterSurfaceRuntime), batch.pipelineKey));
      material.albedoColor = Color3.White();
      material.ambientColor = new Color3(0.38, 0.4, 0.38);
      material.emissiveColor = Color3.Black();
      material.metallic = isWater ? 0 : 1;
      material.enableSpecularAntiAliasing = true;
      material.roughness = isWater ? waterOptics.roughness : 1;
      material.metallicF0Factor = finiteNumber(definition.specularWeight, 0, 1, "Material specular weight");
      material.environmentIntensity = definition.environmentIntensity;
      material.clearCoat.isEnabled = definition.clearCoat > 0;
      material.clearCoat.intensity = definition.clearCoat;
      material.clearCoat.roughness = definition.clearCoatRoughness;
      material.unlit = definition.unlit;
      if (vegetationMode !== undefined) {
        // Thin leaves/grass transmit filtered light on their back face without
        // screen-space scattering targets or changing alpha-test depth writes.
        material.subSurface.isTranslucencyEnabled = true;
        material.subSurface.translucencyIntensity = vegetationMode === "leaves" ? 0.24 : 0.32;
        material.subSurface.useAlbedoToTintTranslucency = true;
        material.subSurface.minimumThickness = 0;
        material.subSurface.maximumThickness = 0.06;
      }
      // OpenVoxel 的网格从外侧观察使用逆时针顶点绕序。Babylon 的右手场景会
      // 默认把 Mesh 设为顺时针正面，因此这里必须在材质边界显式对齐。
      material.sideOrientation = Material.CounterClockWiseSideOrientation;
      material.backFaceCulling = !definition.doubleSided;
      material.twoSidedLighting = definition.doubleSided;
      // One no-cull draw already covers both sides. Splitting it duplicates
      // submission work and conflicts with WebGPU's retained render bundles.
      // Translucent quad order is owned by the world's depth sorter.
      material.separateCullingPass = false;
      if (isWater) {
        // Babylon's PBR reflection path consumes scene.environmentTexture, so every
        // water batch reuses the scene IBL without allocating per-Chunk render targets.
        material.indexOfRefraction = waterOptics.indexOfRefraction;
        material.forceIrradianceInFragment = true;
        material.useSpecularOverAlpha = true;
        material.useRadianceOverAlpha = true;
        material.useLinearAlphaFresnel = true;
        material.enableSpecularAntiAliasing = true;
        material.separateCullingPass = false;
      }
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
      const animated = !isWater && animation !== null && frames.length > 1
        ? {frameDurationMs: animation.frameDurationMs, frames, frameIndex: -1, plugin: texturePlugin} : null;
      material.blockDirtyMechanism = false;
      material.checkReadyOnlyOnce = retained;
      if (retained && owner) material.attachMesh(owner, this.bindingBudget);
      this.materials.set(key, material);
      if (animated) this.animatedMaterials.push(animated);
      return material;
    } catch (error) {
      material.shadowDepthWrapper?.dispose();
      material.shadowDepthWrapper = null;
      material.dispose(true, false);
      throw error;
    }
  }

  disposeMaterial(material) {
    material.shadowDepthWrapper?.dispose();
    material.shadowDepthWrapper = null;
    material.dispose(false, false);
  }

  setEnvironmentFrame(frame) {
    this.vegetationMotionRuntime.setEnvironmentFrame(frame);
    this.waterSurfaceRuntime.setEnvironmentFrame(frame);
  }

  update(deltaMs, playerPosition = this.vegetationMotionRuntime.player) {
    this.waterSurfaceRuntime.update(deltaMs);
    this.vegetationMotionRuntime.update(deltaMs, playerPosition);
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
    if (this.disposed) return;
    this.disposed = true;
    this.animatedMaterials.length = 0;
    for (const material of this.materials.values()) this.disposeMaterial(material);
    this.materials.clear();
    this.pipelines.clear();
    this.sharedUniforms.dispose();
    this.waterSurfaceRuntime.dispose();
  }
}
