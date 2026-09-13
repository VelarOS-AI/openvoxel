const maximumFogDensityFactor = 4.4;
const clearFogStartRatio = 0.66;
const clearFogEndRatio = 0.9;
const severeFogStartRatio = 0.6;
const severeFogEndRatio = 0.83;

function requirePositiveFinite(value, label) {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) {
    throw new RangeError(`${label} must be a positive finite number`);
  }
  return value;
}

/**
 * Keeps weather haze inside the streamed terrain horizon. `renderDistance`
 * is the nominal Chunk-window radius measured in world units. The radius-six
 * forward window keeps same-height terrain complete for at least five Chunk
 * edges from any point in the current Chunk. Even severe weather starts beyond
 * the near landscape and fades through the streamed boundary, so rain reads as
 * depth instead of a gray wall. Sky, clouds and celestial meshes bypass scene
 * fog separately.
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
