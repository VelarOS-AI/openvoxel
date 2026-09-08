import {Constants} from "@babylonjs/core/Engines/constants.js";
import {DirectionalLight} from "@babylonjs/core/Lights/directionalLight.js";
import {HemisphericLight} from "@babylonjs/core/Lights/hemisphericLight.js";
import {ShadowGenerator} from "@babylonjs/core/Lights/Shadows/shadowGenerator.js";
import {Color3} from "@babylonjs/core/Maths/math.color.js";
import {Vector3} from "@babylonjs/core/Maths/math.vector.js";
import {Material} from "@babylonjs/core/Materials/material.js";
import {StandardMaterial} from "@babylonjs/core/Materials/standardMaterial.js";
import {RawCubeTexture} from "@babylonjs/core/Materials/Textures/rawCubeTexture.js";
import {Texture} from "@babylonjs/core/Materials/Textures/texture.js";
import {Mesh} from "@babylonjs/core/Meshes/mesh.js";
import {MeshBuilder} from "@babylonjs/core/Meshes/meshBuilder.js";
import {createCelestialLayer} from "./environment-celestial.mjs";
import {createCloudLayer} from "./environment-clouds.mjs";
import {environmentAlphaIndices} from "./environment-effects.mjs";
import {createEnvironmentIbl, environmentIblNeedsRefresh} from "./environment-ibl.mjs";
import {environmentFogRange} from "./environment-visibility.mjs";
import {ShadowCasterWindow, ShadowRefreshScheduler, shadowLightPosition} from "./shadow-caster-window.mjs";
import {createWeatherParticles} from "./weather-particles.mjs";
import {requireEnvironmentFrame, requireEnvironmentPosition, requireEnvironmentResources, requireFinite} from "./environment-contract.mjs";
import {loadEnvironmentTextures} from "./environment-textures.mjs";
import {createSky} from "./sky-layer.mjs";

const shadowMapSize = 2_048;
const shadowRefreshIntervalMilliseconds = 100;

function seededRandom(seed) {
  let state = seed >>> 0;
  return () => {
    state ^= state << 13;
    state ^= state >>> 17;
    state ^= state << 5;
    return (state >>> 0) / 4_294_967_296;
  };
}

function lightningPath(event, edge) {
  const random = seededRandom((event.sequence ^ 0x9e3779b9) >>> 0);
  const points = [];
  const segments = 14;
  const height = edge * 8;
  for (let index = 0; index <= segments; index += 1) {
    const amount = index / segments;
    const reach = Math.sin(amount * Math.PI) * edge * 0.42;
    points.push(new Vector3(
      event.position.x + (random() - 0.5) * reach,
      event.position.y + height * (1 - amount),
      event.position.z + (random() - 0.5) * reach,
    ));
  }
  points[points.length - 1].set(event.position.x, event.position.y, event.position.z);
  return points;
}

function lightningMaterial(scene, name, color, alpha) {
  const material = new StandardMaterial(name, scene);
  material.diffuseColor = Color3.Black();
  material.emissiveColor = color;
  material.disableLighting = true;
  material.backFaceCulling = false;
  material.transparencyMode = Material.MATERIAL_ALPHABLEND;
  material.disableDepthWrite = true;
  material.fogEnabled = false;
  material.alpha = alpha;
  return material;
}

class BabylonVoxelEnvironment {
  constructor(scene, edge, renderDistance, textures, frame) {
    this.scene = scene;
    this.edge = edge;
    this.renderDistance = renderDistance;
    this.textures = textures;
    this.frame = frame;
    this.disposed = false;
    this.visualWorldMilliseconds = this.frame.worldMilliseconds;
    this.lightningAgeMs = Number.POSITIVE_INFINITY;
    this.lightningSequence = null;
    this.lightningMeshes = [];
    this.rainSplashGrounded = false;
    this.rainSplashGroundY = null;

    this.sky = createSky(scene, renderDistance * 5);
    this.skyLight = new HemisphericLight("openvoxel-sky-light", Vector3.Up(), scene);
    this.sunLight = new DirectionalLight("openvoxel-sun-light", this.frame.sunDirection, scene);
    this.moonLight = new DirectionalLight("openvoxel-moon-light", this.frame.moonDirection, scene);
    this.sunLight.autoUpdateExtends = false;
    this.sunLight.autoCalcShadowZBounds = false;
    // The shadow map tracks the local caster window, so longer terrain view
    // distances do not dilute its texels or grow its draw workload.
    this.sunLight.shadowFrustumSize = edge * 7.5;
    this.sunLight.shadowMinZ = 0.1;
    this.sunLight.shadowMaxZ = renderDistance * 3;
    this.shadowGenerator = new ShadowGenerator(shadowMapSize, this.sunLight);
    this.shadowGenerator.bias = 0.0003;
    this.shadowGenerator.normalBias = 0.02;
    // Babylon darkness is retained sunlight: zero gives full occlusion.
    // Sky irradiance supplies the blue fill inside the resulting shadow.
    this.shadowGenerator.setDarkness(0.08);
    this.shadowGenerator.usePercentageCloserFiltering = true;
    this.shadowGenerator.filteringQuality = ShadowGenerator.QUALITY_MEDIUM;
    this.shadowGenerator.transparencyShadow = true;
    this.shadowGenerator.enableSoftTransparentShadow = true;
    this.shadowGenerator.getShadowMap().refreshRate = 0;
    this.shadowRefresh = new ShadowRefreshScheduler(shadowRefreshIntervalMilliseconds);
    this.shadowCasters = new ShadowCasterWindow({
      edge,
      radius: edge * 3.25,
      activate: (mesh) => this.shadowGenerator.addShadowCaster(mesh, false),
      deactivate: (mesh) => this.shadowGenerator.removeShadowCaster(mesh),
    });

    this.celestial = createCelestialLayer(scene, textures);
    this.clouds = createCloudLayer(scene, textures.clouds, environmentAlphaIndices.clouds);
    this.weather = createWeatherParticles(scene, textures);

    const environmentIbl = createEnvironmentIbl(this.frame);
    this.environmentFaces = environmentIbl.faces;
    this.environmentTexture = new RawCubeTexture(
      scene,
      this.environmentFaces,
      32,
      Constants.TEXTUREFORMAT_RGBA,
      Constants.TEXTURETYPE_UNSIGNED_BYTE,
      true,
      false,
      Texture.TRILINEAR_SAMPLINGMODE,
    );
    this.environmentTexture.name = "openvoxel-dynamic-environment";
    this.environmentTexture.gammaSpace = true;
    this.environmentTexture.sphericalPolynomial = environmentIbl.polynomial;
    this.environmentTexture.level = 0.78;
    scene.environmentTexture = this.environmentTexture;
    this.environmentTextureFrame = this.frame;
    this.environmentTextureUpdates = 1;

    this.lightningCoreMaterial = lightningMaterial(scene, "openvoxel-lightning-core", new Color3(0.95, 0.98, 1), 1);
    this.lightningGlowMaterial = lightningMaterial(scene, "openvoxel-lightning-glow", new Color3(0.28, 0.48, 1), 0.55);
    if (this.frame.lightning != null) {
      this.strike(
        this.frame.lightning,
        this.frame.worldMilliseconds - this.frame.lightning.occurredAtWorldMilliseconds,
      );
    }
    this.updateVisuals(this.frame.lightningFlash);
  }

  updateEnvironmentTexture() {
    const environmentIbl = createEnvironmentIbl(this.frame);
    this.environmentFaces = environmentIbl.faces;
    this.environmentTexture.update(
      this.environmentFaces,
      Constants.TEXTUREFORMAT_RGBA,
      Constants.TEXTURETYPE_UNSIGNED_BYTE,
      false,
    );
    this.environmentTexture.sphericalPolynomial = environmentIbl.polynomial;
    this.environmentTextureFrame = this.frame;
    this.environmentTextureUpdates += 1;
  }

  strike(event, ageMs) {
    for (const mesh of this.lightningMeshes) mesh.dispose(false, false);
    this.lightningMeshes.length = 0;
    if (event == null) {
      this.lightningAgeMs = Number.POSITIVE_INFINITY;
      return;
    }
    this.lightningAgeMs = Math.max(0, ageMs);
    this.lightningSequence = event.sequence;
    // 已经过了可见 bolt 包络的权威事件仍保留 sequence 身份，避免下一次环境
    // 刷新把它当成新雷击重放，但无需再创建 GPU 几何。
    if (this.lightningAgeMs > 850) return;
    const path = lightningPath(event, this.edge);
    const glow = MeshBuilder.CreateTube("openvoxel-lightning-glow:" + event.sequence, {
      path,
      radius: 0.12 + event.intensity * 0.1,
      tessellation: 6,
      cap: Mesh.CAP_ALL,
    }, this.scene);
    const core = MeshBuilder.CreateTube("openvoxel-lightning-core:" + event.sequence, {
      path,
      radius: 0.025 + event.intensity * 0.035,
      tessellation: 6,
      cap: Mesh.CAP_ALL,
    }, this.scene);
    glow.material = this.lightningGlowMaterial;
    core.material = this.lightningCoreMaterial;
    for (const mesh of [glow, core]) {
      mesh.isPickable = false;
      mesh.applyFog = false;
      mesh.renderingGroupId = 4;
    }
    this.lightningMeshes.push(glow, core);
  }

  applyFrame(candidate) {
    const previousSunDirection = this.frame.sunDirection;
    this.frame = requireEnvironmentFrame(candidate);
    if (!previousSunDirection.equals(this.frame.sunDirection)) this.shadowRefresh.invalidate();
    this.visualWorldMilliseconds = this.frame.worldMilliseconds;
    const lightning = this.frame.lightning;
    if (lightning != null) {
      const authoritativeAgeMs = this.frame.worldMilliseconds - lightning.occurredAtWorldMilliseconds;
      if (lightning.sequence !== this.lightningSequence) this.strike(lightning, authoritativeAgeMs);
      else if (this.lightningAgeMs !== Number.POSITIVE_INFINITY) {
        this.lightningAgeMs = Math.max(this.lightningAgeMs, authoritativeAgeMs);
      }
    }
    if (environmentIblNeedsRefresh(this.environmentTextureFrame, this.frame)) this.updateEnvironmentTexture();
    this.updateVisuals(this.frame.lightningFlash);
  }

  updateVisuals(flash) {
    const frame = this.frame;
    this.scene.ambientColor.copyFrom(frame.ground.scale(0.06));
    this.scene.clearColor.set(frame.horizon.r, frame.horizon.g, frame.horizon.b, 1);
    this.scene.fogColor.copyFrom(frame.fog);
    const fog = environmentFogRange(this.renderDistance, frame.fogDensityFactor);
    this.scene.fogStart = fog.start;
    this.scene.fogEnd = fog.end;

    this.sky.material.setColor3("ovSkyTop", frame.skyTop);
    this.sky.material.setColor3("ovHorizon", frame.horizon);
    this.sky.material.setColor3("ovGround", frame.ground);
    this.sky.material.setFloat("ovFlash", flash);

    this.skyLight.intensity = 0.06 + frame.skyIntensity * 0.28 + flash * 0.2;
    this.skyLight.diffuse = Color3.Lerp(new Color3(0.22, 0.28, 0.48), new Color3(0.96, 0.98, 1), frame.daylightIntensity);
    this.skyLight.groundColor.copyFrom(frame.ground);
    this.sunLight.diffuse = Color3.Lerp(new Color3(1, 0.55, 0.28), new Color3(1, 0.96, 0.86), frame.daylightIntensity);
    this.sunLight.intensity = frame.sunIntensity * 2.1 + flash * 0.12;
    this.moonLight.direction.copyFrom(frame.moonDirection);
    this.moonLight.diffuse = new Color3(0.42, 0.52, 0.8);
    this.moonLight.intensity = frame.moonIntensity * 0.5;

    this.celestial.applyFrame(frame);
    this.clouds.applyFrame(frame);
    this.weather.applyFrame(frame);
  }

  update(deltaMs, viewPosition, groundPosition, groundAt = null) {
    deltaMs = requireFinite(deltaMs, "Voxel environment update delta");
    if (deltaMs < 0) throw new RangeError("Voxel environment update delta cannot be negative");
    if (groundAt !== null && groundAt !== undefined && typeof groundAt !== "function") {
      throw new TypeError("Voxel environment groundAt must be a function, null, or undefined");
    }
    const center = requireEnvironmentPosition(viewPosition, "Voxel environment view position");
    const ground = groundPosition === null
      ? null
      : requireEnvironmentPosition(groundPosition, "Voxel environment ground position");
    this.sky.mesh.position.copyFrom(center);
    this.celestial.update(center);
    const celestialRadius = this.renderDistance * 1.45;
    const lightPosition = shadowLightPosition(
      center,
      this.frame.sunDirection,
      this.sunLight.shadowFrustumSize,
      shadowMapSize,
      celestialRadius,
    );
    const previousLightPosition = this.sunLight.position;
    if (Math.abs(previousLightPosition.x - lightPosition.x) > 0.000001
      || Math.abs(previousLightPosition.y - lightPosition.y) > 0.000001
      || Math.abs(previousLightPosition.z - lightPosition.z) > 0.000001
      || !this.sunLight.direction.equals(this.frame.sunDirection)) {
      this.shadowRefresh.invalidate();
    }
    if (this.shadowCasters.update(center)) this.shadowRefresh.invalidate();
    if (this.shadowRefresh.advance(deltaMs)) {
      this.sunLight.position.set(lightPosition.x, lightPosition.y, lightPosition.z);
      this.sunLight.direction.copyFrom(this.frame.sunDirection);
      this.shadowGenerator.getShadowMap().resetRefreshCounter();
    }
    this.moonLight.position.copyFrom(this.celestial.moon.mesh.position);
    this.visualWorldMilliseconds += deltaMs;
    this.clouds.update(center, this.visualWorldMilliseconds);
    this.weather.update(deltaMs, center, ground, groundAt);
    const weatherStats = this.weather.stats();
    this.rainSplashGrounded = ground !== null || weatherStats.activeColumns > 0;
    this.rainSplashGroundY = ground?.y ?? weatherStats.representativeGroundY;
    if (this.lightningAgeMs !== Number.POSITIVE_INFINITY) {
      this.lightningAgeMs += deltaMs;
      const ageSeconds = this.lightningAgeMs / 1_000;
      const envelope = Math.exp(-ageSeconds * 7.5);
      const flicker = ageSeconds < 0.18 ? 0.72 + 0.28 * Math.sin(ageSeconds * 190) ** 2 : 1;
      const intensity = this.frame.lightning?.intensity ?? 0;
      const flash = intensity * envelope * flicker;
      this.lightningCoreMaterial.alpha = Math.min(1, flash * 2.2);
      this.lightningGlowMaterial.alpha = Math.min(0.72, flash * 0.9);
      this.updateVisuals(flash);
      if (ageSeconds > 0.85) {
        for (const mesh of this.lightningMeshes) mesh.dispose(false, false);
        this.lightningMeshes.length = 0;
        this.lightningAgeMs = Number.POSITIVE_INFINITY;
        this.updateVisuals(0);
      }
    }
  }

  invalidateTerrainColumn(chunkX, chunkZ) {
    this.weather.invalidateTerrainColumn(chunkX, chunkZ, this.edge);
    const weather = this.weather.stats();
    this.rainSplashGrounded = weather.activeColumns > 0;
    this.rainSplashGroundY = weather.representativeGroundY;
  }

  restore() {
    this.shadowRefresh.invalidate(true);
    this.environmentTexture.update(
      this.environmentFaces,
      Constants.TEXTUREFORMAT_RGBA,
      Constants.TEXTURETYPE_UNSIGNED_BYTE,
      false,
    );
  }

  addShadowCaster(mesh) {
    this.shadowCasters.add(mesh);
  }

  removeShadowCaster(mesh) {
    this.shadowCasters.delete(mesh);
  }

  stats() {
    const weather = this.weather.stats();
    return {
      environmentTextureReady: this.environmentTexture.isReady(),
      environmentTextureUpdates: this.environmentTextureUpdates,
      precipitation: this.frame.precipitation,
      precipitationIntensity: this.frame.precipitationIntensity,
      cloudiness: this.frame.cloudiness,
      activeRainParticles: this.weather.rain.getActiveCount(),
      activeSnowParticles: this.weather.snow.getActiveCount(),
      activeRainSplashes: this.weather.splash.getActiveCount(),
      activeSnowSplashes: weather.activeSnowSplashes,
      rainSplashContacts: weather.rainSplashContacts,
      snowSplashContacts: weather.snowSplashContacts,
      rainSplashGrounded: this.rainSplashGrounded,
      rainSplashGroundY: this.rainSplashGroundY,
      shadowCasters: this.shadowCasters.totalSize,
      activeShadowCasters: this.shadowCasters.activeSize,
      ...this.celestial.stats(),
      lightningSequence: this.lightningSequence,
    };
  }

  dispose() {
    if (this.disposed) return;
    this.disposed = true;
    this.weather.dispose();
    this.celestial.dispose();
    for (const mesh of this.lightningMeshes) mesh.dispose(false, false);
    this.lightningMeshes.length = 0;
    this.lightningCoreMaterial.dispose(false, false);
    this.lightningGlowMaterial.dispose(false, false);
    this.clouds.mesh.dispose(false, false);
    this.clouds.material.dispose(false, false);
    this.sky.mesh.dispose(false, false);
    this.sky.material.dispose(false, false);
    this.shadowCasters.clear();
    this.shadowGenerator.dispose();
    this.skyLight.dispose();
    this.sunLight.dispose();
    this.moonLight.dispose();
    if (this.scene.environmentTexture === this.environmentTexture) this.scene.environmentTexture = null;
    this.environmentTexture.dispose();
    this.textures.dispose();
  }
}

export async function createEnvironmentAdapter(scene, edge, renderDistance, resources, frame) {
  const checkedResources = requireEnvironmentResources(resources);
  const checkedFrame = requireEnvironmentFrame(frame);
  const textures = await loadEnvironmentTextures(scene, checkedResources);
  try {
    return new BabylonVoxelEnvironment(scene, edge, renderDistance, textures, checkedFrame);
  } catch (error) {
    textures.dispose();
    throw error;
  }
}
