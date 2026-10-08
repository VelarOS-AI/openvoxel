// Bound screen-space work, independent of terrain distance and texture detail.
export const renderBudget = Object.freeze({maximumPixels: 3_600_000, maximumPixelRatio: 2});

export function renderPixelRatio(width, height, devicePixelRatio) {
  const nativeRatio = Math.max(0.5, devicePixelRatio || 1);
  const area = Math.max(1, width) * Math.max(1, height);
  return Math.min(nativeRatio, renderBudget.maximumPixelRatio, Math.sqrt(renderBudget.maximumPixels / area));
}

export function resizeWithinBudget(engine, canvas, devicePixelRatio = globalThis.devicePixelRatio, renderScale = 1) {
  const ratio = renderPixelRatio(canvas.clientWidth, canvas.clientHeight, devicePixelRatio) * renderScale;
  const scaling = 1 / ratio;
  if (Math.abs(engine.getHardwareScalingLevel() - scaling) > 0.001) engine.setHardwareScalingLevel(scaling);
  else engine.resize();
}
