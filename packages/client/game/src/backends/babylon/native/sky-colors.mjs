// The sky and the terrain horizon share display-space atmospheric colors.
// Surface lighting/exposure finishes before terrain is composited into this sky.
export const skyColorShader = `
vec3 ovSkyColor(float directionY, vec3 top, vec3 horizon, vec3 ground, float flash) {
  vec3 lower = mix(ground, horizon, smoothstep(-1.0, 0.0, directionY));
  vec3 color = mix(lower, top, smoothstep(0.0, 0.82, directionY));
  return mix(color, vec3(0.82, 0.88, 1.0), flash * 0.3);
}`;
