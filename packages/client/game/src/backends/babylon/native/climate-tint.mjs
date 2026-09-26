import {climatePaletteColor, climatePaletteShader} from "./climate-palettes.mjs";

const climateTintIntervalMilliseconds = 15_000;
const maximumClimateNodes = 4096;
const maximumClimateChunks = 1024;

const clamp = (value) => Math.max(0, Math.min(1, value));
const smooth = (minimum, maximum, value) => {
  const amount = clamp((value - minimum) / (maximum - minimum));
  return amount * amount * (3 - 2 * amount);
};

const mix = (left, right, amount) => left + (right - left) * amount;
const mixColor = (left, right, amount) => left.map((channel, index) => mix(channel, right[index], amount));
const wrapUnit = (value) => ((value % 1) + 1) % 1;

export const climateTintRoles = Object.freeze({
  neutral: 0,
  grass: 1,
  deciduousFoliage: 2,
  water: 3,
  grassCap: 4,
  evergreenFoliage: 5,
  drylandFoliage: 6,
  aquaticFoliage: 7,
  birchFoliage: 8,
  poplarFoliage: 9,
  tallSpruceFoliage: 10,
});

function seasonalColor(yearProgress, spring, summer, autumn, winter) {
  const phase = wrapUnit(yearProgress - 0.125) * 4;
  const amount = smooth(0, 1, phase - Math.floor(phase));
  if (phase < 1) return mixColor(spring, summer, amount);
  if (phase < 2) return mixColor(summer, autumn, amount);
  if (phase < 3) return mixColor(autumn, winter, amount);
  return mixColor(winter, spring, amount);
}

export function climateTintVector(sample, elevation = 0) {
  return [sample.temperatureCelsius, clamp(sample.humidity), wrapUnit(sample.yearProgress), elevation];
}

/// CPU reference for the shader policy. Tests and future non-Babylon backends use
/// the same semantic roles without depending on shader source or resource keys.
// Species autumn endpoints follow Survivalcraft's deciduous leaf blocks.
// Smooth world-space variation keeps neighbouring crowns from changing in lockstep.
export function foliageVariation(position = {x: 0, y: 0, z: 0}) {
  return 0.5 + 0.5 * Math.sin(position.x * 0.41 + position.z * 0.31);
}

export function foliageSeason(role, year, position) {
  const variation = foliageVariation(position);
  return wrapUnit(year + (role === 8 ? 0.03 : role === 9 ? 0.015 : 0) + (variation - 0.5) * 0.03);
}

export function leafDropIntensity(role, year, position) {
  if (![2, 8, 9].includes(role)) return 0;
  const season = foliageSeason(role, year, position);
  return smooth(0.47, 0.60, season) * (1 - smooth(0.73, 0.86, season));
}

export function climateTintColor(role, climate, position, grassPlant = false) {
  if (role === climateTintRoles.neutral) return [1, 1, 1];
  let base = climatePaletteColor(role, climate[0], clamp(climate[1]));
  if (role === climateTintRoles.water) return base;
  base = naturalVegetationColor(base, role, grassPlant);
  const deciduous = [2, 8, 9].includes(role);
  const evergreen = [5, 6, 7, 10].includes(role);
  const variation = deciduous ? foliageVariation(position) : 0.5;
  const spring = mixColor(base, [157 / 255, 184 / 255, 115 / 255], deciduous ? 0.18 : 0.08);
  const endpoints = role === 8 ? [[220, 170, 30], [255, 230, 70]]
    : role === 9 ? [[220, 130, 20], [255, 190, 60]] : [[230, 80, 0], [255, 130, 20]];
  const autumnTarget = mixColor(...endpoints, variation).map(channel => channel / 255);
  const autumn = mixColor(base, autumnTarget, deciduous ? 1 : evergreen ? 0.04 : 0.3);
  const winter = mixColor(base, [0.60, 0.62, 0.58], deciduous ? 0.75 : evergreen ? 0.12 : 0.55);
  return seasonalColor(deciduous ? foliageSeason(role, climate[2], position) : climate[2], spring, base, autumn, winter);
}

export function applyClimateTint(albedo, role, climate, position, grassPlant = false) {
  const color = climateTintColor(role, climate, position, grassPlant);
  const mask = role === climateTintRoles.grassCap ? smooth(0.015, 0.075, albedo[1] - Math.max(albedo[0], albedo[2])) : 1;
  return albedo.map((channel, index) => mix(channel, channel * color[index], mask));
}

// Keep climate/species variation from the source palettes, but fit their green
// endpoints to this renderer's PBR lighting. Ground is muted olive; grass blades
// are a lighter sage; tree crowns retain a deeper, cooler green.
const vegetationProfiles = {
  ground: {saturation: 0.56, gain: [0.96, 0.88, 0.87]},
  plant: {saturation: 0.63, gain: [1.04, 0.98, 0.98]},
  leaves: {saturation: 0.75, gain: [0.95, 0.93, 0.96]},
};
function naturalVegetationColor(color, role, grassPlant) {
  const grass = role === 1 || role === 4;
  const profile = vegetationProfiles[grass ? grassPlant ? "plant" : "ground" : "leaves"];
  const luminance = color[0] * 0.2126 + color[1] * 0.7152 + color[2] * 0.0722;
  return color.map((channel, i) => mix(luminance, channel, profile.saturation) * profile.gain[i]);
}
const vegetationProfileShader = Object.entries(vegetationProfiles).map(([name, profile]) => `
vec3 ovNatural${name}(vec3 color) {
  float luminance = dot(color, vec3(0.2126, 0.7152, 0.0722));
  return mix(vec3(luminance), color, ${profile.saturation}) * vec3(${profile.gain.join(", ")});
}`).join("\n");

function putBounded(cache, key, value, maximum) {
  if (cache.size >= maximum && !cache.has(key)) cache.delete(cache.keys().next().value);
  cache.set(key, value);
  return value;
}

/// Samples belong to lattice corners, shared by adjacent chunks in all three
/// axes. The shader interpolates them; season updates never alter vertex data.
export class ClimateTintField {
  constructor(edge, sampleAt) {
    this.edge = edge;
    this.sampleAt = sampleAt;
    this.worldMilliseconds = 0;
    this.bucket = -1;
    this.nodes = new Map();
    this.chunks = new Map();
  }

  setTime(worldMilliseconds) {
    const bucket = Math.floor(worldMilliseconds / climateTintIntervalMilliseconds);
    this.worldMilliseconds = bucket * climateTintIntervalMilliseconds;
    if (bucket === this.bucket) return;
    this.bucket = bucket;
    this.nodes.clear();
    this.chunks.clear();
  }

  node(x, y, z) {
    const key = x + ":" + y + ":" + z;
    const existing = this.nodes.get(key);
    if (existing !== undefined) return existing;
    const value = climateTintVector(this.sampleAt(this.worldMilliseconds, x, y, z), y);
    return putBounded(this.nodes, key, value, maximumClimateNodes);
  }

  forPosition(position) {
    const x = Math.floor(position.x / this.edge) * this.edge;
    const y = Math.floor(position.y / this.edge) * this.edge;
    const z = Math.floor(position.z / this.edge) * this.edge;
    const key = x + ":" + y + ":" + z;
    const existing = this.chunks.get(key);
    if (existing !== undefined) return existing;
    const corners = [];
    for (let dy = 0; dy <= 1; dy += 1) {
      for (let dz = 0; dz <= 1; dz += 1) {
        for (let dx = 0; dx <= 1; dx += 1) corners.push(this.node(x + dx * this.edge, y + dy * this.edge, z + dz * this.edge));
      }
    }
    return putBounded(this.chunks, key, {bounds: [x, y, z, this.edge], corners}, maximumClimateChunks);
  }

  clear() {
    this.nodes.clear();
    this.chunks.clear();
  }
}

export const climateTintShader = climatePaletteShader + `
${vegetationProfileShader}
vec3 ovSeasonColor(float yearProgress, vec3 spring, vec3 summer, vec3 autumn, vec3 winter) {
  float phase = fract(yearProgress - 0.125 + 1.0) * 4.0;
  float amount = smoothstep(0.0, 1.0, fract(phase));
  if (phase < 1.0) return mix(spring, summer, amount);
  if (phase < 2.0) return mix(summer, autumn, amount);
  if (phase < 3.0) return mix(autumn, winter, amount);
  return mix(winter, spring, amount);
}
vec3 ovClimateColor(float role, vec4 climate, vec3 position, float grassPlant) {
  if (role < 0.5) return vec3(1.0);
  vec3 base = ovClimatePalette(role, climate);
  if (role > 2.5 && role < 3.5) return base;
  bool grass = (role > 0.5 && role < 1.5) || (role > 3.5 && role < 4.5);
  base = grass ? (grassPlant > 0.5 ? ovNaturalplant(base) : ovNaturalground(base)) : ovNaturalleaves(base);
  bool deciduous = (role > 1.5 && role < 2.5) || (role > 7.5 && role < 9.5);
  bool evergreen = (role > 4.5 && role < 7.5) || role > 9.5;
  float variation = deciduous ? 0.5 + 0.5 * sin(position.x * 0.41 + position.z * 0.31) : 0.5;
  vec3 spring = mix(base, vec3(157.0 / 255.0, 184.0 / 255.0, 115.0 / 255.0), deciduous ? 0.18 : 0.08);
  vec3 low = role > 7.5 && role < 8.5 ? vec3(220.0, 170.0, 30.0) : role > 8.5 && role < 9.5 ? vec3(220.0, 130.0, 20.0) : vec3(230.0, 80.0, 0.0);
  vec3 high = role > 7.5 && role < 8.5 ? vec3(255.0, 230.0, 70.0) : role > 8.5 && role < 9.5 ? vec3(255.0, 190.0, 60.0) : vec3(255.0, 130.0, 20.0);
  vec3 target = mix(low, high, variation) / 255.0;
  vec3 autumn = mix(base, target, deciduous ? 1.0 : evergreen ? 0.04 : 0.3);
  vec3 winter = mix(base, vec3(0.60, 0.62, 0.58), deciduous ? 0.75 : evergreen ? 0.12 : 0.55);
  float offset = role > 7.5 && role < 8.5 ? 0.03 : role > 8.5 && role < 9.5 ? 0.015 : 0.0;
  float season = deciduous ? fract(climate.z + offset + (variation - 0.5) * 0.03 + 1.0) : climate.z;
  return ovSeasonColor(season, spring, base, autumn, winter);
}
vec3 ovApplyClimateTint(vec3 albedo, float role, vec4 climate, vec3 position, float grassPlant) {
  if (role < 0.5) return albedo;
  vec3 color = ovClimateColor(role, climate, position, grassPlant);
  if (role > 2.5 && role < 3.5) return albedo * color;
  // Authored grass-side green coverage identifies the cap at pixel precision;
  // soil remains in its original RGB and every PBR channel stays untouched.
  float mask = role > 3.5 && role < 4.5 ? smoothstep(0.015, 0.075, albedo.g - max(albedo.r, albedo.b)) : 1.0;
  // Preserve authored RGB and multiply once, as in the source game's terrain shader.
  return mix(albedo, albedo * color, mask);
}`;
