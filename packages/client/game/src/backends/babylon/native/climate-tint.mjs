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
export function climateTintColor(role, climate) {
  if (role === climateTintRoles.neutral) return [1, 1, 1];
  const base = climatePaletteColor(role, climate[0], clamp(climate[1]));
  if (role === climateTintRoles.water) return base;
  const deciduous = [2, 8, 9].includes(role);
  const evergreen = [5, 6, 7, 10].includes(role);
  const spring = mixColor(base, [0.63, 1, 0.35], deciduous ? 0.4 : 0.12);
  const autumnTarget = role === 8 ? [0.92, 0.74, 0.10] : role === 9 ? [0.86, 0.62, 0.12] : [0.85, 0.35, 0.06];
  const autumn = mixColor(base, autumnTarget, deciduous ? 0.9 : evergreen ? 0.04 : 0.3);
  const winter = mixColor(base, [0.60, 0.62, 0.58], deciduous ? 0.75 : evergreen ? 0.12 : 0.55);
  return seasonalColor(climate[2], spring, base, autumn, winter);
}

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
vec3 ovSeasonColor(float yearProgress, vec3 spring, vec3 summer, vec3 autumn, vec3 winter) {
  float phase = fract(yearProgress - 0.125 + 1.0) * 4.0;
  float amount = smoothstep(0.0, 1.0, fract(phase));
  if (phase < 1.0) return mix(spring, summer, amount);
  if (phase < 2.0) return mix(summer, autumn, amount);
  if (phase < 3.0) return mix(autumn, winter, amount);
  return mix(winter, spring, amount);
}
vec3 ovClimateColor(float role, vec4 climate) {
  if (role < 0.5) return vec3(1.0);
  vec3 base = ovClimatePalette(role, climate);
  if (role > 2.5 && role < 3.5) return base;
  bool deciduous = (role > 1.5 && role < 2.5) || (role > 7.5 && role < 9.5);
  bool evergreen = (role > 4.5 && role < 7.5) || role > 9.5;
  vec3 spring = mix(base, vec3(0.63, 1.0, 0.35), deciduous ? 0.4 : 0.12);
  vec3 target = role > 7.5 && role < 8.5 ? vec3(0.92, 0.74, 0.10) : role > 8.5 && role < 9.5 ? vec3(0.86, 0.62, 0.12) : vec3(0.85, 0.35, 0.06);
  vec3 autumn = mix(base, target, deciduous ? 0.9 : evergreen ? 0.04 : 0.3);
  vec3 winter = mix(base, vec3(0.60, 0.62, 0.58), deciduous ? 0.75 : evergreen ? 0.12 : 0.55);
  return ovSeasonColor(climate.z, spring, base, autumn, winter);
}
vec3 ovApplyClimateTint(vec3 albedo, float role, vec4 climate) {
  if (role < 0.5) return albedo;
  vec3 color = ovClimateColor(role, climate);
  if (role > 2.5 && role < 3.5) return albedo * color;
  // Authored grass-side green coverage identifies the cap at pixel precision;
  // soil remains in its original RGB and every PBR channel stays untouched.
  float mask = role > 3.5 && role < 4.5 ? smoothstep(0.015, 0.075, albedo.g - max(albedo.r, albedo.b)) : 1.0;
  float detail = max(albedo.r, max(albedo.g, albedo.b));
  return mix(albedo, color * clamp(detail * 1.5, 0.0, 1.25), mask);
}`;
