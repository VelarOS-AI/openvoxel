import {weatherProfile} from "../../../environment/weather-dynamics.mjs";
import {Texture} from "@babylonjs/core/Materials/Textures/texture.js";
import {createPrecipitationColumnField} from "./weather-columns.mjs";
import {createWeatherParticleBatch, weatherBillboardAxes} from "./weather-particle-batch.mjs";
import {
  createWeatherSimulation,
  precipitationParticleProfiles,
  precipitationSkyLight,
  precipitationTopFade,
} from "./weather-simulation.mjs";

export {precipitationParticleProfiles} from "./weather-simulation.mjs";

/** Point sampling and clamp addressing preserve authored pixel silhouettes. */
export function configurePointClampTexture(texture) {
  if (typeof texture !== "object" || texture === null || typeof texture.updateSamplingMode !== "function") {
    throw new TypeError("Precipitation texture must be a Babylon texture");
  }
  texture.hasAlpha = true;
  texture.wrapU = Texture.CLAMP_ADDRESSMODE;
  texture.wrapV = Texture.CLAMP_ADDRESSMODE;
  texture.updateSamplingMode(Texture.NEAREST_SAMPLINGMODE);
  return texture;
}

function cameraForward(scene) {
  const camera = scene.activeCamera;
  if (camera === null || camera === undefined || typeof camera.getForwardRay !== "function") return {x: 0, y: 0, z: 1};
  return camera.getForwardRay().direction;
}

/**
 * Camera-local precipitation shafts draw the authored triangular rain sprite
 * and stable snow atlas cells. Surface hits alone produce impact sprites.
 * `groundAt` returns `{groundY, skyVisible, surface: "water" | "solid"}`;
 * a finite height uses the solid profile, and null means unknown terrain.
 */
export function createWeatherParticles(scene, textures) {
  if (typeof textures !== "object" || textures === null) throw new TypeError("Weather textures must be a record");
  const profiles = precipitationParticleProfiles();
  const rain = createWeatherParticleBatch(scene, configurePointClampTexture(textures.rain), "rain", profiles.rain.capacity);
  const snow = createWeatherParticleBatch(scene, configurePointClampTexture(textures.snow), "snow", profiles.snow.capacity);
  const splash = createWeatherParticleBatch(scene, configurePointClampTexture(textures.rainSplash), "rainSplash", profiles.splash.capacity);
  const snowSplash = createWeatherParticleBatch(scene, textures.snow, "snowSplash", profiles.snowSplash.capacity);
  const batches = [rain, snow, splash, snowSplash];
  const field = createPrecipitationColumnField();
  const simulation = createWeatherSimulation();
  let kind = "none";
  let intensity = 0;
  let light = 1;
  let worldMilliseconds = 0;
  let sourceWorldMilliseconds = null;
  let windX = 0;
  let windZ = 0;
  let fieldStats = {columns: [], cachedColumns: 0, pendingColumns: 0, sampledColumns: 0, maximumColumns: 0};
  let disposed = false;

  return {
    rain,
    snow,
    splash,
    snowSplash,
    invalidateTerrainColumn(chunkX, chunkZ, chunkEdge) {
      const changed = field.invalidateChunkColumn(chunkX, chunkZ, chunkEdge);
      fieldStats = {
        ...fieldStats,
        ...changed,
        columns: fieldStats.columns.filter((column) => Math.floor(column.x / chunkEdge) !== chunkX || Math.floor(column.z / chunkEdge) !== chunkZ),
      };
      simulation.invalidateChunkColumn(chunkX, chunkZ, chunkEdge);
    },
    applyFrame(frame) {
      if (Number.isFinite(frame.worldMilliseconds) && frame.worldMilliseconds !== sourceWorldMilliseconds) {
        sourceWorldMilliseconds = frame.worldMilliseconds;
        worldMilliseconds = frame.worldMilliseconds;
      }
      kind = frame.precipitation;
      intensity = kind === "none" ? 0 : frame.precipitationIntensity;
      light = precipitationSkyLight(frame.daylightIntensity);
      windX = frame.windX;
      windZ = frame.windZ;
    },
    update(deltaMs, center, fallbackGround, groundAt) {
      if (disposed) return;
      worldMilliseconds += deltaMs;
      const forward = cameraForward(scene);
      const hasFallingParticles = simulation.shafts.size > 0;
      if (intensity > 0 || hasFallingParticles) {
        fieldStats = field.update(deltaMs, center, forward, fallbackGround, groundAt);
      } else {
        fieldStats = {...fieldStats, columns: [], sampledColumns: 0};
      }
      const columns = fieldStats.columns;
      simulation.update(deltaMs, center, columns, kind, intensity, windX, windZ, worldMilliseconds);
      const axes = weatherBillboardAxes(forward);
      for (const batch of batches) batch.reset();
      for (const shaft of simulation.shafts.values()) {
        const batch = shaft.kind === "rain" ? rain : snow;
        for (const particle of shaft.particles) {
          if (!particle.active) continue;
          const distance = Math.hypot(particle.x - center.x, particle.y - center.y, particle.z - center.z);
          // Keep close flakes/drops from becoming giant opaque shapes at the eye.
          const nearFade = Math.max(0, Math.min(1, (distance - 0.6) / 1.2));
          batch.append(particle, axes, light, precipitationTopFade(particle.y, center.y) * nearFade * particle.opacity);
        }
      }
      for (const particle of simulation.rainSplashes) {
        if (particle.active) splash.append(particle, axes, light, Math.min(1, particle.fadeFactor * particle.remaining));
      }
      for (const particle of simulation.snowSplashes) {
        if (particle.active) snowSplash.append(particle, axes, light, Math.min(1, particle.fadeFactor * particle.remaining));
      }
      rain.emitRate = kind === "rain" ? columns.length * 4 * intensity : 0;
      snow.emitRate = kind === "snow" ? columns.length * 0.7 * intensity : 0;
      for (const batch of batches) batch.upload();
    },
    stats() {
      return {
        ...simulation.stats(),
        severity: weatherProfile(kind, intensity, Math.hypot(windX, windZ)).level,
        activeColumns: fieldStats.columns.length,
        representativeGroundY: fieldStats.columns[0]?.groundY ?? null,
        cachedColumns: fieldStats.cachedColumns,
        pendingColumns: fieldStats.pendingColumns,
        sampledColumns: fieldStats.sampledColumns,
        maximumColumns: fieldStats.maximumColumns,
        activeSnowSplashes: snowSplash.getActiveCount(),
      };
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      for (const batch of batches) batch.dispose();
      simulation.reset();
      field.reset();
    },
  };
}
