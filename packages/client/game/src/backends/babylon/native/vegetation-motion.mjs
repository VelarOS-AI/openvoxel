import {MaterialPluginBase} from "@babylonjs/core/Materials/materialPluginBase.js";
import {windGustShader} from "../../../environment/weather-dynamics.mjs";

const motionShader = {
  vine: `
vec3 ovVineWorld = (world * vec4(positionUpdated, 1.0)).xyz;
float ovWindSpeed = length(ovVegetationWind.xy);
vec2 ovWindDirection = ovWindSpeed > 0.01 ? ovVegetationWind.xy / ovWindSpeed : vec2(0.8, 0.6);
// One continuous phase down the strand. UV.y restarts on every block and
// would pin one side of each join while moving the other side.
float ovPhase = ovVegetationWind.w * 1.2 + dot(ovVineWorld.xz, vec2(0.29, 0.21));
vec3 ovTangent = vec3(-normalUpdated.z, 0.0, normalUpdated.x);
float ovSway = min(ovWindSpeed, 12.0) * 0.0017 * sin(ovPhase)
  * ovWindGust(ovVegetationWind.w, ovVineWorld.xz);
// Clinging vines move along their support, maintaining the 1/64 inset.
// World coordinates make matching vertices identical across chunk borders.
positionUpdated += ovTangent * dot(ovWindDirection, ovTangent.xz) * ovSway;`,
  cross: `
vec3 ovPlantWorld = (world * vec4(positionUpdated, 1.0)).xyz;
float ovWindSpeed = length(ovVegetationWind.xy);
vec2 ovWindDirection = ovWindSpeed > 0.01 ? ovVegetationWind.xy / ovWindSpeed : vec2(0.8, 0.6);
float ovPhase = ovVegetationWind.w * 1.6 + dot(ovPlantWorld.xz, vec2(0.29, 0.21));
float ovGust = ovWindGust(ovVegetationWind.w, ovPlantWorld.xz);
vec2 ovSway = ovWindDirection * min(ovWindSpeed, 12.0) * 0.013
  * (0.45 + 0.55 * sin(ovPhase)) * ovGust;
vec3 ovAway = ovPlantWorld - ovVegetationPlayer.xyz;
float ovNear = (1.0 - smoothstep(0.35, 2.2, length(ovAway.xz)))
  * (1.0 - smoothstep(1.3, 3.0, abs(ovAway.y)));
vec2 ovPush = normalize(ovAway.xz + vec2(0.001)) * (0.17 * ovVegetationPlayer.w * ovNear);
positionUpdated.xz += clamp(uvUpdated.y, 0.0, 1.0) * (ovSway + ovPush);`,
  leaves: `
vec3 ovLeafWorld = (world * vec4(positionUpdated, 1.0)).xyz;
float ovWindSpeed = length(ovVegetationWind.xy);
vec2 ovWindDirection = ovWindSpeed > 0.01 ? ovVegetationWind.xy / ovWindSpeed : vec2(0.8, 0.6);
float ovPhase = ovVegetationWind.w * 1.2 + dot(ovLeafWorld.xz, vec2(0.18, 0.14)) + ovLeafWorld.y * 0.19;
positionUpdated.xz += ovWindDirection * min(ovWindSpeed, 12.0) * 0.0045
  * sin(ovPhase) * ovWindGust(ovVegetationWind.w, ovLeafWorld.xz);`,
};

export class VegetationMotionRuntime {
  constructor(frame) {
    this.timeSeconds = 0;
    this.windX = 0;
    this.windZ = 0;
    this.player = {x: 0, y: 0, z: 0};
    this.previousPlayer = null;
    this.movement = 0;
    this.setEnvironmentFrame(frame);
  }

  setEnvironmentFrame(frame) {
    const windX = frame?.windX ?? 0;
    const windZ = frame?.windZ ?? 0;
    if (!Number.isFinite(windX) || !Number.isFinite(windZ)) throw new TypeError("Vegetation wind must be finite");
    this.windX = windX;
    this.windZ = windZ;
    if (Number.isFinite(frame?.worldMilliseconds)) this.timeSeconds = frame.worldMilliseconds / 1000;
  }

  update(deltaMs, player) {
    if (!Number.isFinite(deltaMs) || deltaMs < 0) throw new RangeError("Vegetation delta must be finite and non-negative");
    if (![player?.x, player?.y, player?.z].every(Number.isFinite)) throw new TypeError("Vegetation player position must be finite");
    const seconds = deltaMs / 1_000;
    this.timeSeconds += seconds;
    const previous = this.previousPlayer;
    const speed = previous === null || seconds === 0 ? 0 : Math.hypot(player.x - previous.x, player.z - previous.z) / seconds;
    const target = Math.min(1, speed / 3);
    this.movement += (target - this.movement) * (1 - Math.exp(-seconds * 8));
    this.player = {x: player.x, y: player.y, z: player.z};
    this.previousPlayer = this.player;
  }
}

export class VegetationMotionPlugin extends MaterialPluginBase {
  constructor(material, mode, runtime) {
    if (!(mode in motionShader)) throw new RangeError("Vegetation motion mode must be cross, vine, or leaves");
    if (!(runtime instanceof VegetationMotionRuntime)) throw new TypeError("Vegetation motion needs a shared runtime");
    super(material, "OpenVoxelVegetationMotion", 230, {}, true, false, true);
    this.mode = mode;
    this.runtime = runtime;
    this._enable(true);
  }

  getClassName() { return "VegetationMotionPlugin"; }

  isCompatible(shaderLanguage) { return shaderLanguage === 0; }

  getUniforms() {
    return {ubo: [
      {name: "ovVegetationWind", size: 4, type: "vec4"},
      {name: "ovVegetationPlayer", size: 4, type: "vec4"},
    ], vertex: "uniform vec4 ovVegetationWind;\nuniform vec4 ovVegetationPlayer;"};
  }

  bindForSubMesh(uniformBuffer) {
    const runtime = this.runtime;
    uniformBuffer.updateFloat4("ovVegetationWind", runtime.enabled === false ? 0 : runtime.windX, runtime.enabled === false ? 0 : runtime.windZ, 0, runtime.timeSeconds);
    uniformBuffer.updateFloat4("ovVegetationPlayer", runtime.player.x, runtime.player.y, runtime.player.z, runtime.enabled === false ? 0 : runtime.movement);
  }

  getCustomCode(shaderType) {
    if (shaderType !== "vertex") return null;
    return {
      CUSTOM_VERTEX_DEFINITIONS: windGustShader,
      CUSTOM_VERTEX_UPDATE_POSITION: `
vec3 ovMotionWorld = (world * vec4(positionUpdated, 1.0)).xyz;
float ovMotionDistance = length(ovMotionWorld - ovVegetationPlayer.xyz);
if (ovMotionDistance < 72.0) {
  vec3 ovStillPosition = positionUpdated;
  ${motionShader[this.mode] ?? ""}
  positionUpdated = mix(ovStillPosition, positionUpdated, 1.0 - smoothstep(40.0, 72.0, ovMotionDistance));
}`,
    };
  }
}
