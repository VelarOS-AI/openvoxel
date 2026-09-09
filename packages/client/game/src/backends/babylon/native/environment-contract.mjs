import {Color3} from "@babylonjs/core/Maths/math.color.js";
import {Vector3} from "@babylonjs/core/Maths/math.vector.js";

export function requireFinite(value, label) {
  if (typeof value !== "number" || !Number.isFinite(value)) throw new TypeError(label + " must be a finite number");
  return value;
}

function requireInteger(value, minimum, maximum, label) {
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
    throw new RangeError(label + " must be an integer from " + minimum + " through " + maximum);
  }
  return value;
}

function requireEmbeddedWebp(value, label) {
  if (typeof value !== "string" || !value.startsWith("data:image/webp;base64,")) {
    throw new TypeError(label + " must be an embedded WebP image");
  }
  return value;
}

export function requireEnvironmentResources(value) {
  if (typeof value !== "object" || value === null) throw new TypeError("Voxel environment resources must be a record");
  const sky = value.sky;
  const clouds = value.clouds;
  const precipitation = value.precipitation;
  if (typeof sky !== "object" || sky === null) throw new TypeError("Voxel environment sky resources must be a record");
  if (typeof clouds !== "object" || clouds === null) throw new TypeError("Voxel environment cloud resources must be a record");
  if (typeof precipitation !== "object" || precipitation === null) throw new TypeError("Voxel environment precipitation resources must be a record");
  if (!Array.isArray(sky.moonDataUrls) || sky.moonDataUrls.length !== 8) {
    throw new RangeError("Voxel environment needs exactly eight moon phase images");
  }
  return {
    sky: {
      sunDataUrl: requireEmbeddedWebp(sky.sunDataUrl, "Voxel environment sun"),
      glowDataUrl: requireEmbeddedWebp(sky.glowDataUrl, "Voxel environment sky glow"),
      starDataUrl: requireEmbeddedWebp(sky.starDataUrl, "Voxel environment star"),
      moonDataUrls: sky.moonDataUrls.map((dataUrl, index) => requireEmbeddedWebp(dataUrl, "Voxel environment moon phase " + index)),
    },
    clouds: {
      textureDataUrl: requireEmbeddedWebp(clouds.textureDataUrl, "Voxel environment clouds"),
    },
    precipitation: {
      rainDataUrl: requireEmbeddedWebp(precipitation.rainDataUrl, "Voxel environment rain"),
      rainSplashDataUrl: requireEmbeddedWebp(precipitation.rainSplashDataUrl, "Voxel environment rain splash"),
      snowDataUrl: requireEmbeddedWebp(precipitation.snowDataUrl, "Voxel environment snow"),
    },
  };
}

function requireUnit(value, label) {
  value = requireFinite(value, label);
  if (value < 0 || value > 1) throw new RangeError(label + " must be from 0 through 1");
  return value;
}

function requireEnvironmentColor(value, label) {
  if (typeof value !== "object" || value === null) throw new TypeError(label + " must be a color record");
  return new Color3(
    requireUnit(value.red, label + " red"),
    requireUnit(value.green, label + " green"),
    requireUnit(value.blue, label + " blue"),
  );
}

function requireEnvironmentVector(value, label) {
  if (typeof value !== "object" || value === null) throw new TypeError(label + " must be a vector record");
  const vector = new Vector3(
    requireFinite(value.x, label + " x"),
    requireFinite(value.y, label + " y"),
    requireFinite(value.z, label + " z"),
  );
  if (Math.abs(vector.lengthSquared() - 1) > 0.002) throw new RangeError(label + " must be normalized");
  return vector;
}

export function requireEnvironmentPosition(value, label) {
  if (typeof value !== "object" || value === null) throw new TypeError(label + " must be a position record");
  requireFinite(value.x, label + " x");
  requireFinite(value.y, label + " y");
  requireFinite(value.z, label + " z");
  return value;
}

export function requireEnvironmentFrame(value) {
  if (typeof value !== "object" || value === null) throw new TypeError("Voxel environment frame must be a record");
  if (!["none", "rain", "snow"].includes(value.precipitation)) throw new TypeError("Voxel environment precipitation kind is invalid");
  const worldMilliseconds = requireFinite(value.worldMilliseconds, "Voxel environment world milliseconds");
  if (worldMilliseconds < 0 || worldMilliseconds > Number.MAX_SAFE_INTEGER) {
    throw new RangeError("Voxel environment world milliseconds are outside the supported range");
  }
  if (typeof value.samplePosition !== "object" || value.samplePosition === null) {
    throw new TypeError("Voxel environment sample position must be a record");
  }
  const samplePosition = {
    x: requireInteger(value.samplePosition.x, -33_554_431, 33_554_431, "Voxel environment sample x"),
    y: requireInteger(value.samplePosition.y, -33_554_431, 33_554_431, "Voxel environment sample y"),
    z: requireInteger(value.samplePosition.z, -33_554_431, 33_554_431, "Voxel environment sample z"),
  };
  const lightning = value.lightning;
  if (lightning != null) {
    requireInteger(lightning.sequence, 0, Number.MAX_SAFE_INTEGER, "Voxel lightning sequence");
    if (typeof lightning.position !== "object" || lightning.position === null) throw new TypeError("Voxel lightning position must be a record");
    requireInteger(lightning.position.x, -33_554_431, 33_554_431, "Voxel lightning x");
    requireInteger(lightning.position.y, -33_554_431, 33_554_431, "Voxel lightning y");
    requireInteger(lightning.position.z, -33_554_431, 33_554_431, "Voxel lightning z");
    requireUnit(lightning.intensity, "Voxel lightning intensity");
    if (lightning.intensity === 0) throw new RangeError("Voxel lightning intensity must be greater than zero");
    const occurredAt = requireInteger(lightning.occurredAtWorldMilliseconds, 0, Number.MAX_SAFE_INTEGER, "Voxel lightning occurrence time");
    if (occurredAt > worldMilliseconds) throw new RangeError("Voxel lightning cannot occur after its environment frame");
  }
  const windX = requireFinite(value.windX, "Voxel environment wind x");
  const windZ = requireFinite(value.windZ, "Voxel environment wind z");
  if (windX * windX + windZ * windZ > 64 * 64) throw new RangeError("Voxel environment wind exceeds 64 blocks per second");
  const precipitationIntensity = requireUnit(value.precipitationIntensity, "Voxel environment precipitation intensity");
  if (value.precipitation === "none" && precipitationIntensity !== 0) {
    throw new RangeError("Voxel clear environment cannot carry precipitation intensity");
  }
  return {
    ...value,
    worldMilliseconds,
    samplePosition,
    timeOfDay: requireUnit(value.timeOfDay, "Voxel environment time of day"),
    moonPhase: requireInteger(value.moonPhase, 0, 7, "Voxel environment moon phase"),
    cloudiness: requireUnit(value.cloudiness, "Voxel environment cloudiness"),
    precipitationIntensity,
    windX,
    windZ,
    lightning,
    sunDirection: requireEnvironmentVector(value.sunDirection, "Voxel environment sun direction"),
    moonDirection: requireEnvironmentVector(value.moonDirection, "Voxel environment moon direction"),
    daylightIntensity: requireUnit(value.daylightIntensity, "Voxel environment daylight intensity"),
    nightIntensity: requireUnit(value.nightIntensity, "Voxel environment night intensity"),
    starIntensity: requireUnit(value.starIntensity, "Voxel environment star intensity"),
    sunIntensity: requireUnit(value.sunIntensity, "Voxel environment sun intensity"),
    moonIntensity: requireUnit(value.moonIntensity, "Voxel environment moon intensity"),
    skyIntensity: requireUnit(value.skyIntensity, "Voxel environment sky intensity"),
    skyTop: requireEnvironmentColor(value.skyTop, "Voxel environment sky top"),
    horizon: requireEnvironmentColor(value.horizon, "Voxel environment horizon"),
    ground: requireEnvironmentColor(value.ground, "Voxel environment ground"),
    fog: requireEnvironmentColor(value.fog, "Voxel environment fog"),
    fogDensityFactor: requireFinite(value.fogDensityFactor, "Voxel environment fog density factor"),
    cloudOpacity: requireUnit(value.cloudOpacity, "Voxel environment cloud opacity"),
    cloudBrightness: requireUnit(value.cloudBrightness, "Voxel environment cloud brightness"),
    weatherDimming: requireUnit(value.weatherDimming, "Voxel environment weather dimming"),
    lightningFlash: requireUnit(value.lightningFlash, "Voxel environment lightning flash"),
  };
}
