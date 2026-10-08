import {atmosphereSun, sampleSkyToRef} from "./sky-colors.mjs";
import {CubeMapToSphericalPolynomialTools} from "@babylonjs/core/Misc/HighDynamicRange/cubemapToSphericalPolynomial.js";

const colorStep = 1 / 32;
const intensityStep = 1 / 32;
const minimumDirectionDot = Math.cos(Math.PI / 90);

function colorChanged(previous, next) {
  return Math.abs(previous.r - next.r) >= colorStep
    || Math.abs(previous.g - next.g) >= colorStep
    || Math.abs(previous.b - next.b) >= colorStep;
}

/// The sky shader and weather effects follow every authoritative frame, while
/// the much more expensive six-face IBL upload advances only after a visible
/// lighting change. Both inputs have already crossed the typed adapter boundary.
export function environmentIblNeedsRefresh(previous, next) {
  if (previous === null) return true;
  const directionDot = previous.sunDirection.x * next.sunDirection.x
    + previous.sunDirection.y * next.sunDirection.y
    + previous.sunDirection.z * next.sunDirection.z;
  return directionDot <= minimumDirectionDot
    || Math.abs(previous.sunIntensity - next.sunIntensity) >= intensityStep
    || Math.abs(previous.weatherDimming - next.weatherDimming) >= intensityStep
    || Math.abs((previous.cloudiness ?? 0) - (next.cloudiness ?? 0)) >= intensityStep
    || colorChanged(previous.skyTop, next.skyTop)
    || colorChanged(previous.horizon, next.horizon)
    || colorChanged(previous.ground, next.ground);
}

// Cached unit vectors avoid allocating arrays per pixel on every sky update.
const directionCache = new Map();
function cubeDirections(size) {
  let result = directionCache.get(size);
  if (result) return result;
  result = new Float32Array(6 * size * size * 3);
  let offset = 0;
  for (let face = 0; face < 6; face++) for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) {
    const u = (x + .5) / size * 2 - 1, v = (y + .5) / size * 2 - 1;
    const dx = face === 0 ? 1 : face === 1 ? -1 : face === 5 ? -u : u;
    const dy = face === 2 ? 1 : face === 3 ? -1 : -v;
    const dz = face === 0 ? -u : face === 1 ? u : face === 2 ? v : face === 3 ? -v : face === 4 ? 1 : -1;
    const length = Math.hypot(dx, dy, dz);
    result[offset++] = dx / length; result[offset++] = dy / length; result[offset++] = dz / length;
  }
  if (directionCache.size >= 2) directionCache.delete(directionCache.keys().next().value);
  directionCache.set(size, result);
  return result;
}

/// Keep the diffuse irradiance and reflected sky derived from the same CPU
/// pixels. Reading six faces back from the GPU would stall the rendering thread;
/// leaving Babylon's cached polynomial in place would preserve yesterday's light.
export function createEnvironmentIbl(frame, size = 32) {
  const directions = cubeDirections(size), sun = atmosphereSun(frame), color = [0, 0, 0];
  const faces = Array.from({length: 6}, (_, face) => {
    const bytes = new Uint8Array(size * size * 4);
    for (let pixel = 0; pixel < size * size; pixel++) {
      const offset = (face * size * size + pixel) * 3;
      sampleSkyToRef(directions[offset], directions[offset + 1], directions[offset + 2], frame, sun, color);
      for (let channel = 0; channel < 3; channel++) bytes[pixel * 4 + channel] = Math.round(Math.min(1, color[channel]) * 255);
      bytes[pixel * 4 + 3] = 255;
    }
    return bytes;
  });
  const [right, left, up, down, front, back] = faces;
  const polynomial = CubeMapToSphericalPolynomialTools.ConvertCubeMapToSphericalPolynomial({
    size, right, left, up, down, front, back,
    format: 5,
    type: 0,
    gammaSpace: true,
  }, 16);
  return {faces, polynomial};
}
