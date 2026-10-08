import assert from "node:assert/strict";
import test from "node:test";
import {renderBudget, renderPixelRatio, resizeWithinBudget} from "../src/backends/babylon/native/render-budget.mjs";

test("retina rendering stays inside the pixel budget without upscaling low-DPI displays", () => {
  for (const [width, height, dpr] of [[1512, 784, 2], [1920, 1080, 2], [3840, 2160, 2], [1280, 800, 1], [800, 600, 0.8]]) {
    const ratio = renderPixelRatio(width, height, dpr);
    assert.ok(width * height * ratio ** 2 <= renderBudget.maximumPixels + 1);
    assert.ok(ratio <= dpr);
  }
  assert.equal(renderPixelRatio(1280, 800, 1), 1);
  assert.equal(renderPixelRatio(800, 600, 2), 2);
});


test("render scale reduces pixel work without increasing the retina budget", () => {
  let scaling = 1;
  const engine = {getHardwareScalingLevel: () => scaling, setHardwareScalingLevel: value => { scaling = value; }, resize() {}};
  const canvas = {clientWidth: 1920, clientHeight: 1080};
  resizeWithinBudget(engine, canvas, 2, 1);
  const fullResolution = 1 / scaling;
  resizeWithinBudget(engine, canvas, 2, .65);
  assert.ok(Math.abs(1 / scaling - fullResolution * .65) < 1e-10);
});
