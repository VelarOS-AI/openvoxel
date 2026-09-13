import assert from "node:assert/strict";
import {join} from "node:path";
import sharp from "sharp";

export async function assertWorldMinimap(page, screenshotsDirectory) {
  const panel = page.locator("[data-minimap]");
  const canvas = page.locator("[data-map-canvas]");
  await panel.waitFor();
  await page.waitForFunction(() => Number(document.querySelector("[data-map-canvas]")?.getAttribute("data-map-frames")) > 2);
  assert.equal(await panel.locator("button, select, input").count(), 0);
  assert.match(await canvas.getAttribute("aria-label"), /North up/u);
  assert.equal(await panel.evaluate((element) => getComputedStyle(element).borderRadius), "50%");
  const bounds = await panel.boundingBox();
  const viewport = page.viewportSize();
  assert.ok(bounds.x > viewport.width / 2 && bounds.y < 30, "Minimap must mount in the top-right corner");
  assert.ok(Number(await canvas.getAttribute("data-map-meshes")) > 0, "Minimap must render the uploaded world meshes");
  const start = Number(await canvas.getAttribute("data-map-frames"));
  await page.waitForTimeout(1100);
  const updated = Number(await canvas.getAttribute("data-map-frames")) - start;
  assert.ok(updated >= 1 && updated <= 7, "Minimap must keep its bounded refresh cadence");
  const path = join(screenshotsDirectory, "03-minimap-live.png");
  await panel.screenshot({path});
  const {data, info} = await sharp(path).removeAlpha().raw().toBuffer({resolveWithObject: true});
  const colors = new Set();
  let terrainPixels = 0;
  for (let y = 0; y < info.height; y += 1) {
    for (let x = 0; x < info.width; x += 1) {
      if (Math.hypot(x - info.width / 2, y - info.height / 2) > info.width * 0.38) continue;
      const offset = (y * info.width + x) * info.channels;
      colors.add(`${data[offset] >> 3}:${data[offset + 1] >> 3}:${data[offset + 2] >> 3}`);
      if (data[offset] + data[offset + 1] + data[offset + 2] > 120) terrainPixels += 1;
    }
  }
  assert.ok(colors.size > 35 && terrainPixels > 500, `Minimap has no detailed terrain picture: ${colors.size} colors, ${terrainPixels} pixels`);
  process.stdout.write(`Minimap world position x=${await canvas.getAttribute("data-map-x")} z=${await canvas.getAttribute("data-map-z")}; ${colors.size} colors, ${terrainPixels} terrain pixels\n`);
}
