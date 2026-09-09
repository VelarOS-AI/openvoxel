/**
 * Transparent meshes in rendering group 1 are drawn in ascending alphaIndex
 * order. Keep distant light sources behind cloud coverage instead of relying
 * on Babylon's bounding-sphere distance sort for unrelated sky geometry.
 */
export const environmentAlphaIndices = Object.freeze({
  stars: 10,
  sunGlow: 20,
  moonGlow: 25,
  sun: 30,
  moon: 40,
  clouds: 50,
});
