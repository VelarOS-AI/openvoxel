const maximumFogDensityFactor = 4.4;
const clearFogStartRatio = 0.66;
const clearFogEndRatio = 0.9;
const severeFogStartRatio = 0.54;
const severeFogEndRatio = 0.78;

function requirePositiveFinite(value, label) {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) {
    throw new RangeError(`${label} must be a positive finite number`);
  }
  return value;
}

/**
 * Keeps weather haze inside the streamed terrain horizon. `renderDistance`
 * is the nominal Chunk-window radius measured in world units. The radius-five
 * spherical window keeps same-height terrain complete for at least four Chunk
 * edges from any point in the current Chunk. Haze begins before that boundary
 * and finishes gradually beyond it, preserving a useful landscape view instead
 * of turning ordinary weather into a wall. Sky, clouds and celestial meshes
 * bypass scene fog separately.
 */
export function environmentFogRange(renderDistance, densityFactor) {
  renderDistance = requirePositiveFinite(renderDistance, "Environment render distance");
  densityFactor = requirePositiveFinite(densityFactor, "Environment fog density factor");
  const weatherAmount = Math.min(1, Math.max(0, densityFactor - 1) / (maximumFogDensityFactor - 1));
  return {
    start: renderDistance * (clearFogStartRatio + (severeFogStartRatio - clearFogStartRatio) * weatherAmount),
    end: renderDistance * (clearFogEndRatio + (severeFogEndRatio - clearFogEndRatio) * weatherAmount),
  };
}
