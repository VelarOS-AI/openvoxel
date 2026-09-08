const climateTintIntervalMilliseconds = 15_000;
const maximumClimateNodes = 4096;
const maximumClimateChunks = 1024;

const clamp = (value) => Math.max(0, Math.min(1, value));
const smooth = (minimum, maximum, value) => {
  const amount = clamp((value - minimum) / (maximum - minimum));
  return amount * amount * (3 - 2 * amount);
};

export function climateTintVector(sample) {
  const year = sample.yearProgress;
  const autumn = smooth(0.46, 0.61, year) * (1 - smooth(0.73, 0.84, year));
  const coldDormancy = 1 - smooth(-8, 7, sample.temperatureCelsius);
  return [sample.temperatureCelsius, sample.humidity, autumn, coldDormancy];
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
    const value = climateTintVector(this.sampleAt(this.worldMilliseconds, x, y, z));
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

export const climateTintShader = `
vec3 ovClimateColor(float role, vec4 climate) {
  float warmth = smoothstep(-5.0, 30.0, climate.x);
  float humidity = clamp(climate.y, 0.0, 1.0);
  float dry = (1.0 - smoothstep(0.16, 0.62, humidity)) * smoothstep(12.0, 32.0, climate.x);
  vec3 grass = mix(vec3(0.57, 0.68, 0.48), vec3(0.39, 0.68, 0.25), warmth);
  grass = mix(grass, vec3(0.27, 0.60, 0.24), humidity * warmth * 0.65);
  grass = mix(grass, vec3(0.77, 0.67, 0.35), dry);
  grass = mix(grass, vec3(0.64, 0.64, 0.49), climate.w * 0.65);
  if (role < 1.5 || role > 3.5) return grass;
  if (role < 2.5) {
    vec3 foliage = mix(vec3(0.46, 0.61, 0.33), vec3(0.26, 0.59, 0.23), humidity);
    vec3 autumn = mix(vec3(0.82, 0.57, 0.18), vec3(0.72, 0.29, 0.11), humidity);
    foliage = mix(foliage, autumn, climate.z * (1.0 - smoothstep(20.0, 30.0, climate.x)));
    return mix(foliage, vec3(0.49, 0.55, 0.46), climate.w * 0.66);
  }
  return mix(vec3(0.48, 0.80, 0.91), vec3(0.36, 0.68, 0.79), humidity);
}
vec3 ovApplyClimateTint(vec3 albedo, float role, vec4 climate) {
  if (role < 0.5) return albedo;
  vec3 color = ovClimateColor(role, climate);
  if (role > 2.5 && role < 3.5) return albedo * color;
  // Authored grass-side green coverage identifies the cap at pixel precision;
  // soil remains in its original RGB and every PBR channel stays untouched.
  float mask = role > 3.5 ? smoothstep(0.015, 0.075, albedo.g - max(albedo.r, albedo.b)) : 1.0;
  float detail = max(albedo.r, max(albedo.g, albedo.b));
  return mix(albedo, color * clamp(detail * 1.5, 0.0, 1.25), mask);
}`;
