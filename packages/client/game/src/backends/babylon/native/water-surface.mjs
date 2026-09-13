import {MaterialPluginBase} from "@babylonjs/core/Materials/materialPluginBase.js";

export class WaterSurfaceRuntime {
  constructor() {
    this.timeSeconds = 0;
    this.plugins = new Set();
    this.disposed = false;
  }

  attach(plugin) {
    if (this.disposed) throw new Error("Water surface runtime is disposed");
    this.plugins.add(plugin);
  }

  detach(plugin) {
    this.plugins.delete(plugin);
  }

  update(deltaMs) {
    if (!Number.isFinite(deltaMs) || deltaMs < 0) throw new RangeError("Water surface delta must be a finite non-negative number");
    if (this.disposed) return;
    this.timeSeconds += deltaMs / 1_000;
  }

  dispose() {
    if (this.disposed) return;
    this.disposed = true;
    this.plugins.clear();
  }
}

export class VoxelWaterSurfacePlugin extends MaterialPluginBase {
  constructor(material, normalTexture, optics, runtime) {
    if (normalTexture == null || typeof normalTexture.isReady !== "function") {
      throw new TypeError("Water surface needs a normal texture array");
    }
    if (optics == null || !Array.isArray(optics.waves) || optics.waves.length !== 2) {
      throw new TypeError("Water surface needs exactly two resolved normal waves");
    }
    if (!(runtime instanceof WaterSurfaceRuntime)) throw new TypeError("Water surface needs a shared runtime");
    super(material, "OpenVoxelWaterSurface", 210, {}, true, false, true);
    this.normalTexture = normalTexture;
    this.optics = optics;
    this.runtime = runtime;
    this.runtime.attach(this);
    this._enable(true);
  }

  getClassName() {
    return "OpenVoxelWaterSurfacePlugin";
  }

  isCompatible(shaderLanguage) {
    return shaderLanguage === 0;
  }

  isReadyForSubMesh() {
    return this.normalTexture.isReady();
  }

  getSamplers(samplers) {
    samplers.push("ovWaterNormalSampler");
  }

  getUniforms() {
    return {ubo: [
      {name: "ovWaterTimeSeconds", size: 1, type: "float"},
      {name: "ovWaterNormalLayers", size: 2, type: "vec2"},
      {name: "ovWaterWaveA", size: 4, type: "vec4"},
      {name: "ovWaterWaveB", size: 4, type: "vec4"},
      {name: "ovWaterNormalStrength", size: 1, type: "float"},
    ]};
  }

  bindForSubMesh(uniformBuffer) {
    const [waveA, waveB] = this.optics.waves;
    uniformBuffer.updateFloat("ovWaterTimeSeconds", this.runtime.timeSeconds);
    uniformBuffer.updateFloat2("ovWaterNormalLayers", waveA.layer, waveB.layer);
    uniformBuffer.updateFloat4("ovWaterWaveA", waveA.directionX, waveA.directionZ, waveA.scale, waveA.speed);
    uniformBuffer.updateFloat4("ovWaterWaveB", waveB.directionX, waveB.directionZ, waveB.scale, waveB.speed);
    uniformBuffer.updateFloat("ovWaterNormalStrength", this.optics.normalStrength);
    uniformBuffer.setTexture("ovWaterNormalSampler", this.normalTexture);
  }

  hasTexture(texture) {
    return texture === this.normalTexture;
  }

  getActiveTextures(textures) {
    textures.push(this.normalTexture);
  }

  getCustomCode(shaderType) {
    if (shaderType !== "fragment") return null;
    return {
      CUSTOM_FRAGMENT_DEFINITIONS: `
precision highp sampler2DArray;
uniform sampler2DArray ovWaterNormalSampler;
uniform float ovWaterTimeSeconds;
uniform vec2 ovWaterNormalLayers;
uniform vec4 ovWaterWaveA;
uniform vec4 ovWaterWaveB;
uniform float ovWaterNormalStrength;`,
      CUSTOM_FRAGMENT_BEFORE_LIGHTS: `
vec2 ovWaterUvA = vPositionW.xz * ovWaterWaveA.z + ovWaterWaveA.xy * (ovWaterTimeSeconds * ovWaterWaveA.w);
vec2 ovWaterUvB = vPositionW.xz * ovWaterWaveB.z + ovWaterWaveB.xy * (ovWaterTimeSeconds * ovWaterWaveB.w);
vec3 ovWaterNormalA = texture(ovWaterNormalSampler, vec3(ovWaterUvA, ovWaterNormalLayers.x)).xyz * 2.0 - 1.0;
vec3 ovWaterNormalB = texture(ovWaterNormalSampler, vec3(ovWaterUvB, ovWaterNormalLayers.y)).xyz * 2.0 - 1.0;
vec2 ovWaterSlope = 0.5 * (
  ovWaterNormalA.xy / max(0.2, abs(ovWaterNormalA.z)) +
  ovWaterNormalB.xy / max(0.2, abs(ovWaterNormalB.z)));
vec3 ovWaterRippleNormal = normalize(vec3(
  ovWaterSlope.x * ovWaterNormalStrength,
  1.0,
  ovWaterSlope.y * ovWaterNormalStrength));
float ovWaterOrientation = normalW.y < 0.0 ? -1.0 : 1.0;
float ovWaterHorizontal = smoothstep(0.7, 0.98, abs(normalW.y));
normalW = normalize(mix(normalW, ovWaterRippleNormal * ovWaterOrientation, ovWaterHorizontal));`,
    };
  }

  dispose() {
    this.runtime.detach(this);
    super.dispose(false);
  }
}
