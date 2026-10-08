// The sky and the terrain horizon share display-space atmospheric colors.
// Surface lighting/exposure finishes before terrain is composited into this sky.
export const skyColorShader = `
vec3 ovSkyColor(float directionY, vec3 top, vec3 horizon, vec3 ground, float flash) {
  vec3 lower = mix(ground, horizon, smoothstep(-1.0, 0.0, directionY));
  vec3 color = mix(lower, top, smoothstep(0.0, 0.82, directionY));
  return mix(color, vec3(0.82, 0.88, 1.0), flash * 0.3);
}`;

// Display-space aerial scattering is shared by the sky, terrain horizon and
// reflected environment. The celestial sprite remains the actual solar disc.
export const directionalSkyShader = `${skyColorShader}
vec3 ovDirectionalSky(vec3 direction, vec3 top, vec3 horizon, vec3 ground, float flash, vec4 sun, vec3 sunColor) {
  vec3 color = ovSkyColor(direction.y, top, horizon, ground, flash);
  float alignment = max(0.0, dot(direction, sun.xyz));
  float halo = (pow(alignment, 8.0) * 0.16 + pow(alignment, 64.0) * 0.3)
    * sun.w * smoothstep(-0.12, 0.08, direction.y);
  return color + (vec3(1.0) - color) * sunColor * halo;
}`;

function smoothstep(low, high, value) {
  const t = Math.max(0, Math.min(1, (value - low) / (high - low)));
  return t * t * (3 - 2 * t);
}

export function atmosphereSun(frame) {
  const direction = frame.sunDirection;
  const elevation = -direction.y;
  const warm = smoothstep(0.04, 0.55, elevation);
  return {
    x: -direction.x, y: elevation, z: -direction.z,
    intensity: frame.sunIntensity * smoothstep(-0.04, 0.06, elevation) * (1 - (frame.cloudiness ?? 0) * 0.8),
    r: 1, g: 0.48 + warm * 0.42, b: 0.2 + warm * 0.52,
  };
}

export function sampleSkyToRef(x, y, z, frame, sun, result) {
  const lower = smoothstep(-1, 0, y), upper = smoothstep(0, 0.82, y);
  const alignment = Math.max(0, x * sun.x + y * sun.y + z * sun.z);
  const halo = (alignment ** 8 * 0.16 + alignment ** 64 * 0.3) * sun.intensity * smoothstep(-0.12, 0.08, y);
  for (let i = 0; i < 3; i++) {
    const channel = i === 0 ? "r" : i === 1 ? "g" : "b";
    const low = frame.ground[channel] + (frame.horizon[channel] - frame.ground[channel]) * lower;
    const base = low + (frame.skyTop[channel] - low) * upper;
    result[i] = base + (1 - base) * sun[channel] * halo;
  }
  return result;
}
