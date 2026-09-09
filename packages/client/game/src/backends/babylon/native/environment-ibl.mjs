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
    || colorChanged(previous.skyTop, next.skyTop)
    || colorChanged(previous.horizon, next.horizon)
    || colorChanged(previous.ground, next.ground);
}

// WebGL cube order: +X, -X, +Y, -Y, +Z, -Z. The rows use the same
// orientation as Babylon's diffuse-irradiance integration.
function cubeDirection(face, u, v) {
  const vector = [
    [1, -v, -u], [-1, -v, u], [u, 1, v],
    [u, -1, -v], [u, -v, 1], [-u, -v, -1],
  ][face];
  const length = Math.hypot(...vector);
  return vector.map((value) => value / length);
}

/// Keep the diffuse irradiance and reflected sky derived from the same CPU
/// pixels. Reading six faces back from the GPU would stall the rendering thread;
/// leaving Babylon's cached polynomial in place would preserve yesterday's light.
export function createEnvironmentIbl(frame, size = 32) {
  const faces = Array.from({length: 6}, (_, face) => {
    const bytes = new Uint8Array(size * size * 4);
    for (let y = 0; y < size; y += 1) {
      for (let x = 0; x < size; x += 1) {
        const direction = cubeDirection(face, (x + 0.5) / size * 2 - 1, (y + 0.5) / size * 2 - 1);
        const low = direction[1] < 0 ? frame.ground : frame.horizon;
        const high = direction[1] < 0 ? frame.horizon : frame.skyTop;
        const amount = direction[1] < 0 ? direction[1] + 1 : direction[1];
        const alignment = -(direction[0] * frame.sunDirection.x + direction[1] * frame.sunDirection.y + direction[2] * frame.sunDirection.z);
        const sun = Math.pow(Math.max(0, alignment), 384) * frame.sunIntensity * 3.5;
        const offset = (y * size + x) * 4;
        for (const [channel, name] of ["r", "g", "b"].entries()) {
          const base = low[name] + (high[name] - low[name]) * amount;
          bytes[offset + channel] = Math.round(Math.min(1, base * frame.weatherDimming + sun * [1, 0.9, 0.72][channel]) * 255);
        }
        bytes[offset + 3] = 255;
      }
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
