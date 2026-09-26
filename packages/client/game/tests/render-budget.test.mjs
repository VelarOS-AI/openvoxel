import assert from "node:assert/strict";
import test from "node:test";
import {renderBudget, renderPixelRatio} from "../src/backends/babylon/native/render-budget.mjs";

test("retina rendering stays inside the pixel budget without upscaling low-DPI displays", () => {
  for (const [width, height, dpr] of [[1512, 784, 2], [1920, 1080, 2], [3840, 2160, 2], [1280, 800, 1], [800, 600, 0.8]]) {
    const ratio = renderPixelRatio(width, height, dpr);
    assert.ok(width * height * ratio ** 2 <= renderBudget.maximumPixels + 1);
    assert.ok(ratio <= dpr);
  }
  assert.equal(renderPixelRatio(1280, 800, 1), 1);
  assert.equal(renderPixelRatio(800, 600, 2), 2);
});
