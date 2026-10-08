import {MaterialPluginBase} from "@babylonjs/core/Materials/materialPluginBase.js";
import {directionalSkyShader} from "./sky-colors.mjs";

// Streaming visibility is predominantly horizontal. Flying above nearby ground
// must not turn the vertical separation into a full-length horizon fog bank.
export const terrainFogVerticalScale = 0.35;

export function terrainFogOpacity(horizontalDistance, verticalDistance, start, end) {
  const distance = Math.hypot(horizontalDistance, verticalDistance * terrainFogVerticalScale);
  const amount = Math.min(1, Math.max(0, (distance - start) / (end - start)));
  return amount * amount * (3 - 2 * amount);
}

/** PBR terrain only. Sky and weather retain their own atmospheric treatment. */
export class TerrainFogPlugin extends MaterialPluginBase {
  constructor(material, atmosphere) {
    super(material, "OpenVoxelTerrainFog", 220, {}, true, false, true);
    const fallback = material.getScene().fogColor;
    this.atmosphere = atmosphere ?? {skyTop: fallback, horizon: fallback, ground: fallback, flash: 0};
    this.scene = material.getScene();
    this._enable(true);
  }

  getClassName() { return "TerrainFogPlugin"; }

  isCompatible(shaderLanguage) { return shaderLanguage === 0; }

  getUniforms() {
    return {ubo: [
      {name: "ovTerrainSkyTop", size: 3, type: "vec3"},
      {name: "ovTerrainHorizon", size: 3, type: "vec3"},
      {name: "ovTerrainGround", size: 3, type: "vec3"},
      {name: "ovTerrainFlash", size: 1, type: "float"},
      {name: "ovTerrainFogEnabled", size: 1, type: "float"},
      {name: "ovAtmosphereSun", size: 4, type: "vec4"},
      {name: "ovAtmosphereSunColor", size: 3, type: "vec3"},
    ], fragment: `uniform vec3 ovTerrainSkyTop;
uniform vec3 ovTerrainHorizon;
uniform vec3 ovTerrainGround;
uniform float ovTerrainFlash;
uniform float ovTerrainFogEnabled;
uniform vec4 ovAtmosphereSun;
uniform vec3 ovAtmosphereSunColor;`};
  }

  bindForSubMesh(uniformBuffer) {
    const {skyTop, horizon, ground, flash} = this.atmosphere;
    uniformBuffer.updateFloat3("ovTerrainSkyTop", skyTop.r, skyTop.g, skyTop.b);
    uniformBuffer.updateFloat3("ovTerrainHorizon", horizon.r, horizon.g, horizon.b);
    uniformBuffer.updateFloat3("ovTerrainGround", ground.r, ground.g, ground.b);
    uniformBuffer.updateFloat("ovTerrainFlash", flash);
    uniformBuffer.updateFloat("ovTerrainFogEnabled", this.scene?.activeCamera?.metadata?.openVoxelMinimap === true ? 0 : 1);
    const sun = this.atmosphere.sun;
    uniformBuffer.updateFloat4("ovAtmosphereSun", sun?.x ?? 0, sun?.y ?? 1, sun?.z ?? 0, sun?.intensity ?? 0);
    uniformBuffer.updateFloat3("ovAtmosphereSunColor", sun?.r ?? 1, sun?.g ?? 1, sun?.b ?? 1);
  }

  getCustomCode(shaderType) {
    if (shaderType !== "fragment") return null;
    return {
      CUSTOM_FRAGMENT_DEFINITIONS: `
${directionalSkyShader}
#ifdef FOG
float ovTerrainFogTransmittance() {
  vec3 delta = vPositionW - vEyePosition.xyz;
  delta.y *= ${terrainFogVerticalScale};
  return 1.0 - smoothstep(vFogInfos.y, vFogInfos.z, length(delta)) * ovTerrainFogEnabled;
}
#endif`,
      // Transmittance is a ratio, not a color. The sky's display-space palette
      // must not pass through PBR exposure a second time at the horizon.
      "!float fog=CalcFogFactor\\(\\);": "float fog=ovTerrainFogTransmittance();",
      "!fog=toLinearSpace\\(fog\\);": "/* OpenVoxel transmittance is already linear. */",
      "!finalColor\\.rgb=mix\\(vFogColor,finalColor\\.rgb,fog\\);": "/* Atmosphere follows surface image processing. */",
      CUSTOM_FRAGMENT_BEFORE_FRAGCOLOR: `
#ifdef FOG
  vec3 ovAtmosphereDirection = normalize(vPositionW - vEyePosition.xyz);
  vec3 ovAtmosphereColor = ovDirectionalSky(ovAtmosphereDirection, ovTerrainSkyTop, ovTerrainHorizon, ovTerrainGround, ovTerrainFlash, ovAtmosphereSun, ovAtmosphereSunColor);
  ovAtmosphereColor *= ovSkyVisibility;
#ifdef PREMULTIPLYALPHA
  ovAtmosphereColor *= finalColor.a;
#endif
  finalColor.rgb = mix(ovAtmosphereColor, finalColor.rgb, fog);
#endif`,
    };
  }
}
