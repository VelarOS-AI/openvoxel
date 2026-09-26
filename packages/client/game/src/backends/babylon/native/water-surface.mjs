import {RawTexture} from "@babylonjs/core/Materials/Textures/rawTexture.js";
import {Matrix} from "@babylonjs/core/Maths/math.vector.js";
import {MaterialPluginBase} from "@babylonjs/core/Materials/materialPluginBase.js";
import {windGust} from "../../../environment/weather-dynamics.mjs";

export class WaterSurfaceRuntime {
  constructor(scene) {
    this.timeSeconds = 0;
    this.wind = 1;
    this.windSpeed = 0;
    this.daylight = 1;
    this.capture = null;
    this.scene = scene;
    this.identity = Matrix.Identity();
    this.fallback = RawTexture.CreateRGBATexture(new Uint8Array([0, 0, 0, 255]), 1, 1, scene, false, false);
    this.plugins = new Set();
    this.disposed = false;
  }

  setEnvironmentFrame(frame) {
    this.windSpeed = Math.hypot(frame.windX, frame.windZ);
    this.wind = Math.min(1.8, 0.35 + this.windSpeed * 0.16);
    if (Number.isFinite(frame.worldMilliseconds)) this.timeSeconds = frame.worldMilliseconds / 1000;
    this.daylight = frame.daylightIntensity ?? 1;
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
    const position = this.scene.activeCamera?.position;
    this.wind = Math.min(1.8, 0.35 + this.windSpeed * windGust(this.timeSeconds, position?.x ?? 0, position?.z ?? 0) * 0.16);
  }

  dispose() {
    if (this.disposed) return;
    this.disposed = true;
    this.plugins.clear();
    this.fallback.dispose();
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
    samplers.push("ovWaterNormalSampler", "ovWaterReflectionSampler", "ovWaterRefractionSampler");
  }

  getUniforms() {
    return {ubo: [
      {name: "ovWaterCaptureInfo", size: 4, type: "vec4"},
      {name: "ovWaterReflectionMatrix", size: 16, type: "mat4"},
      {name: "ovWaterRefractionMatrix", size: 16, type: "mat4"},
      {name: "ovWaterTimeSeconds", size: 1, type: "float"},
      {name: "ovWaterNormalLayers", size: 2, type: "vec2"},
      {name: "ovWaterWaveA", size: 4, type: "vec4"},
      {name: "ovWaterWaveB", size: 4, type: "vec4"},
      {name: "ovWaterNormalStrength", size: 1, type: "float"},
    ]};
  }

  bindForSubMesh(uniformBuffer) {
    const [waveA, waveB] = this.optics.waves;
    const capture = this.runtime.capture;
    const usable = capture?.usable(this._material.getScene()) === true;
    uniformBuffer.updateFloat4("ovWaterCaptureInfo", usable ? capture.blend : 0, capture?.level ?? 0, this.runtime.wind, this.runtime.daylight);
    uniformBuffer.updateMatrix("ovWaterReflectionMatrix", capture?.reflectionMatrix ?? this.runtime.identity);
    uniformBuffer.updateMatrix("ovWaterRefractionMatrix", capture?.refractionMatrix ?? this.runtime.identity);
    uniformBuffer.setTexture("ovWaterReflectionSampler", capture?.reflection ?? this.runtime.fallback);
    uniformBuffer.setTexture("ovWaterRefractionSampler", capture?.refraction ?? this.runtime.fallback);
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
    if (shaderType === "vertex") return {
      CUSTOM_VERTEX_DEFINITIONS: "\nvarying float ovWaterCode;",
      CUSTOM_VERTEX_MAIN_END: "\novWaterCode = color.a;",
    };
    if (shaderType !== "fragment") return null;
    return {
      CUSTOM_FRAGMENT_DEFINITIONS: `
precision highp sampler2DArray;
varying float ovWaterCode;
uniform sampler2DArray ovWaterNormalSampler;
uniform sampler2D ovWaterReflectionSampler;
uniform sampler2D ovWaterRefractionSampler;
uniform mat4 ovWaterReflectionMatrix;
uniform mat4 ovWaterRefractionMatrix;
uniform vec4 ovWaterCaptureInfo;
uniform float ovWaterTimeSeconds;
uniform vec2 ovWaterNormalLayers;
uniform vec4 ovWaterWaveA;
uniform vec4 ovWaterWaveB;
uniform float ovWaterNormalStrength;
float ovWaterFlow() { return step(0.5, ovWaterCode); }
float ovWaterDepth() { return clamp((ovWaterCode - 0.05 - 0.5 * ovWaterFlow()) / 0.4, 0.0, 1.0); }
float ovWaterHash(vec2 cell) {
  vec3 p = fract(vec3(cell.xyx) * 0.1031);
  p += dot(p, p.yzx + 33.33);
  return fract((p.x + p.y) * p.z);
}
// Analytic gradient of a smooth 2D height field. Unlike plane waves, its
// crests have finite extent instead of forming stripes across the whole lake.
vec2 ovWaterGradient(vec2 p) {
  vec2 cell = floor(p);
  vec2 f = fract(p);
  vec2 u = f * f * f * (f * (f * 6.0 - 15.0) + 10.0);
  vec2 du = 30.0 * f * f * (f * (f - 2.0) + 1.0);
  float a = ovWaterHash(cell);
  float b = ovWaterHash(cell + vec2(1.0, 0.0));
  float c = ovWaterHash(cell + vec2(0.0, 1.0));
  float d = ovWaterHash(cell + vec2(1.0, 1.0));
  return du * vec2(mix(b - a, d - c, u.y), mix(c - a, d - b, u.x));
}
vec2 ovWaterProject(mat4 transform, vec3 position) {
  vec4 clip = transform * vec4(position, 1.0);
  return clip.xy / max(0.001, clip.w) * 0.5 + 0.5;
}
vec2 ovWaterCaptureUv(vec2 base, vec2 distorted) {
  // Fade the displacement before reaching the capture edge, so clamp cannot
  // stretch one edge pixel into a moving band across the water.
  vec2 border = min(base, 1.0 - base);
  float fade = smoothstep(0.002, 0.04, min(border.x, border.y));
  return clamp(mix(base, distorted, fade), 0.002, 0.998);
}`,
      CUSTOM_FRAGMENT_UPDATE_ALBEDO: `
float ovDepth = ovWaterDepth();
surfaceAlbedo = vec3(0.018, 0.13, 0.14);
alpha *= mix(0.25, 1.15, ovDepth);`,
      CUSTOM_FRAGMENT_BEFORE_LIGHTS: `
float ovFlow = ovWaterFlow();
float ovWaveSpeed = mix(0.7, 2.1, ovFlow);
vec2 ovCurrent = mix(vec2(0.0), normalize(ovWaterWaveA.xy + ovWaterWaveB.xy * 0.2) * 0.12, ovFlow);
vec2 ovWaterUvA = vPositionW.xz * ovWaterWaveA.z + (ovWaterWaveA.xy * ovWaterWaveA.w * ovWaveSpeed + ovCurrent) * ovWaterTimeSeconds;
vec2 ovWaterUvB = vPositionW.xz * ovWaterWaveB.z + (ovWaterWaveB.xy * ovWaterWaveB.w * ovWaveSpeed + ovCurrent * 0.7) * ovWaterTimeSeconds;
vec3 ovWaterNormalA = texture(ovWaterNormalSampler, vec3(ovWaterUvA, ovWaterNormalLayers.x)).xyz * 2.0 - 1.0;
vec3 ovWaterNormalB = texture(ovWaterNormalSampler, vec3(ovWaterUvB, ovWaterNormalLayers.y)).xyz * 2.0 - 1.0;
vec2 ovWaterSlope = 0.5 * (
  ovWaterNormalA.xy / max(0.2, abs(ovWaterNormalA.z)) +
  ovWaterNormalB.xy / max(0.2, abs(ovWaterNormalB.z)));
// World-space phases remain continuous across chunks. Filter every octave
// by its projected pixel footprint, including the broad waves at the horizon.
vec2 ovWavePosition = vPositionW.xz + ovCurrent * ovWaterTimeSeconds * 5.0;
float ovWaveClock = ovWaterTimeSeconds * ovWaveSpeed;
float ovFootprint = max(length(dFdx(vPositionW.xz)), length(dFdy(vPositionW.xz)));
mat2 ovRotate = mat2(0.8, 0.6, -0.6, 0.8);
vec2 ovBroadSlope = ovWaterGradient(ovWavePosition * 0.65 - ovWaterWaveA.xy * ovWaveClock * 0.22)
  * 0.38 * (1.0 - smoothstep(0.3, 1.5, ovFootprint * 0.65));
vec2 ovCrossSlope = transpose(ovRotate) * ovWaterGradient(ovRotate * ovWavePosition * 1.4 + ovWaterWaveB.xy * ovWaveClock * 0.31 + vec2(7.3, 2.1))
  * 0.22 * (1.0 - smoothstep(0.3, 1.5, ovFootprint * 1.4));
vec2 ovFineSlope = ovWaterGradient(ovWavePosition * 3.8 - vec2(0.15, 0.21) * ovWaveClock + vec2(19.1, 5.7))
  * 0.08 * (1.0 - smoothstep(0.3, 1.5, ovFootprint * 3.8));
ovWaterSlope *= 1.0 - smoothstep(0.3, 1.5, ovFootprint * 3.8);
ovWaterSlope += (ovBroadSlope + ovCrossSlope + ovFineSlope) * ovWaterCaptureInfo.z;
float ovGeometricFacing = abs(normalize(vEyePosition.xyz - vPositionW).y);
// Subpixel crests at grazing angles resolve to the mean surface normal.
// This also keeps the perturbed normal from flipping away from the viewer.
ovWaterSlope *= mix(0.08, 1.0, smoothstep(0.025, 0.3, ovGeometricFacing));
vec3 ovWaterRippleNormal = normalize(vec3(
  ovWaterSlope.x * ovWaterNormalStrength * mix(0.8, 1.45, ovFlow),
  1.0,
  ovWaterSlope.y * ovWaterNormalStrength * mix(0.8, 1.45, ovFlow)));
float ovWaterOrientation = normalW.y < 0.0 ? -1.0 : 1.0;
float ovWaterHorizontal = smoothstep(0.7, 0.98, abs(normalW.y));
normalW = normalize(mix(normalW, ovWaterRippleNormal * ovWaterOrientation, ovWaterHorizontal));`,
      CUSTOM_FRAGMENT_BEFORE_FRAGCOLOR: `
// Captures use the same display-space exposure as the terrain. Absorption is
// evaluated in linear light; the atmosphere plugin follows this composition.
if (ovWaterCaptureInfo.x > 0.001 && ovWaterHorizontal > 0.9 && normalW.y > 0.0 && abs(vPositionW.y - ovWaterCaptureInfo.y) < 0.12) {
  vec2 ovReflectUv = ovWaterProject(ovWaterReflectionMatrix, vPositionW);
  vec2 ovRefractUv = ovWaterProject(ovWaterRefractionMatrix, vPositionW);
  // Project a world-space displacement: its apparent size follows distance
  // and camera orientation, instead of applying a fixed screen-space shift.
  vec3 ovDisplacement = vec3(normalW.x, 0.0, normalW.z) * mix(0.35, 1.5, ovWaterDepth());
  vec2 ovReflectSample = ovWaterProject(ovWaterReflectionMatrix, vPositionW + ovDisplacement);
  vec2 ovRefractSample = ovWaterProject(ovWaterRefractionMatrix, vPositionW - ovDisplacement);
  vec3 ovReflected = toLinearSpace(texture2D(ovWaterReflectionSampler, ovWaterCaptureUv(ovReflectUv, ovReflectSample)).rgb);
  vec3 ovBottom = toLinearSpace(texture2D(ovWaterRefractionSampler, ovWaterCaptureUv(ovRefractUv, ovRefractSample)).rgb);
  float ovFacing = clamp(dot(normalW, normalize(vEyePosition.xyz - vPositionW)), 0.0, 1.0);
  float ovOpticalDepth = (0.45 + ovWaterDepth() * 7.0) / max(0.45, ovFacing);
  vec3 ovTransmittance = exp(-vec3(0.24, 0.065, 0.045) * ovOpticalDepth);
  vec3 ovScatter = vec3(0.012, 0.105, 0.11) * mix(0.008, 1.0, ovWaterCaptureInfo.w) * ovSkyVisibility;
  vec3 ovTransmitted = ovBottom * ovTransmittance + ovScatter * (1.0 - ovTransmittance);
  float ovFresnel = 0.0204 + 0.9796 * pow(1.0 - ovFacing, 5.0);
  vec3 ovWaterColor = mix(ovTransmitted, ovReflected, ovFresnel);
#ifdef SPECULARTERM
  // A single direct sun glint; celestial sprites are excluded from the mirror.
  ovWaterColor += toLinearSpace(applyImageProcessing(vec4(finalSpecularScaled, 1.0)).rgb);
#endif
  finalColor.rgb = mix(finalColor.rgb, toGammaSpace(ovWaterColor), ovWaterCaptureInfo.x);
  finalColor.a = mix(finalColor.a, 1.0, ovWaterCaptureInfo.x);
}`,

    };
  }

  dispose() {
    this.runtime.detach(this);
    super.dispose(false);
  }
}
