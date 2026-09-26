import assert from "node:assert/strict";
import {join} from "node:path";
import sharp from "sharp";
import {screenshotsDirectory} from "./ui-acceptance-paths.mjs";

export async function screenshot(page, name) {
  await page.screenshot({ path: join(screenshotsDirectory, `${name}.png`), fullPage: true });
}

export async function dispatchCarouselWheel(page, init) {
  return page.locator('[data-app][data-screen="world-home"]').evaluate((element, wheelInit) => {
    const event = new WheelEvent("wheel", {
      bubbles: true,
      cancelable: true,
      ...wheelInit,
    });
    element.dispatchEvent(event);
    return event.defaultPrevented;
  }, init);
}

async function voxelSceneMetrics(png) {
  const metadata = await sharp(png).metadata();
  assert.ok(metadata.width != null && metadata.height != null, "Voxel screenshot has no dimensions");
  const region = {
    left: Math.floor(metadata.width * 0.12),
    top: Math.floor(metadata.height * 0.45),
    width: Math.floor(metadata.width * 0.76),
    height: Math.floor(metadata.height * 0.42),
  };
  const {data, info} = await sharp(png).extract(region).removeAlpha().raw().toBuffer({resolveWithObject: true});
  const luminance = new Uint32Array(256);
  let nearBlack = 0;
  let colorful = 0;
  let edgeDelta = 0;
  let edgeCount = 0;
  let visibleEdges = 0;
  for (let y = 0; y < info.height; y += 1) {
    for (let x = 0; x < info.width; x += 1) {
      const offset = (y * info.width + x) * 3;
      const red = data[offset];
      const green = data[offset + 1];
      const blue = data[offset + 2];
      luminance[Math.round(0.2126 * red + 0.7152 * green + 0.0722 * blue)] += 1;
      if (red <= 4 && green <= 4 && blue <= 4) nearBlack += 1;
      if (Math.max(red, green, blue) - Math.min(red, green, blue) >= 12) colorful += 1;
      if (x > 0) {
        const delta = (Math.abs(red - data[offset - 3]) + Math.abs(green - data[offset - 2]) + Math.abs(blue - data[offset - 1])) / 3;
        edgeDelta += delta;
        if (delta >= 1) visibleEdges += 1;
        edgeCount += 1;
      }
    }
  }
  const pixels = info.width * info.height;
  // Exposed marble/granite can occupy the entire foreground. Preserve the
  // color-loss fence using an independent midground band as well; foreground
  // luminance and geometry checks remain tied to the original sampling area.
  const midground = await sharp(png).extract({
    left: region.left, width: region.width,
    top: Math.floor(metadata.height * 0.20), height: Math.floor(metadata.height * 0.24),
  }).removeAlpha().raw().toBuffer();
  let midgroundColorful = 0;
  for (let offset = 0; offset < midground.length; offset += 3) {
    if (Math.max(midground[offset], midground[offset + 1], midground[offset + 2]) - Math.min(midground[offset], midground[offset + 1], midground[offset + 2]) >= 12) midgroundColorful += 1;
  }
  let cumulative = 0;
  let medianLuminance = 255;
  for (let value = 0; value < luminance.length; value += 1) {
    cumulative += luminance[value];
    if (cumulative >= pixels * 0.5) {
      medianLuminance = value;
      break;
    }
  }
  return {
    nearBlackRatio: nearBlack / pixels,
    medianLuminance,
    colorfulPixelRatio: colorful / pixels,
    midgroundColorfulPixelRatio: midgroundColorful / (midground.length / 3),
    meanEdgeDelta: edgeDelta / edgeCount,
    visibleEdgeRatio: visibleEdges / edgeCount,
  };
}

export async function assertVoxelSample(canvas, path, label) {
  const metrics = await voxelSceneMetrics(await canvas.screenshot({ path }));
  const evidence = `${JSON.stringify(metrics)}; screenshot: ${path}`;
  assert.ok(metrics.nearBlackRatio < 0.85, `${label} foreground is predominantly black: ${evidence}`);
  // A flying camera can legitimately frame mostly moonless sky. Geometry and
  // texture visibility are guarded independently below, so keep this only as
  // a near-black render-loss fence rather than a daytime exposure target.
  assert.ok(metrics.medianLuminance >= 16, `${label} foreground is too dark: ${evidence}`);
  // Preserve the stronger daytime color fence without rejecting a valid
  // moonlit scene whose material colors are intentionally exposure-compressed.
  const minimumColorfulPixelRatio = metrics.medianLuminance < 32 ? 0.04 : 0.1;
  assert.ok(Math.max(metrics.colorfulPixelRatio, metrics.midgroundColorfulPixelRatio) >= minimumColorfulPixelRatio, `${label} scene lost its color channels: ${evidence}`);
  // Day, night, snow, rain and dense fog legitimately produce very different
  // average contrast. Count actual discontinuities instead of requiring a
  // day-scene mean; deterministic texture/PBR deltas belong to the GPU probe.
  assert.ok(metrics.visibleEdgeRatio >= 0.005, `${label} foreground has no visible geometry edges: ${evidence}`);
}

async function waitForVoxelSample(canvas, path, label, timeoutMilliseconds = 10_000) {
  const deadline = Date.now() + timeoutMilliseconds;
  let lastFailure = null;
  while (Date.now() < deadline) {
    try {
      await assertVoxelSample(canvas, path, label);
      return;
    } catch (error) {
      lastFailure = error;
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
  }
  throw new Error(`${label} did not recover visible geometry within ${timeoutMilliseconds} milliseconds`, {cause: lastFailure});
}

export async function assertRenderedGeometry(page) {
  const stage = page.locator('[data-app][data-screen="world"]');
  const [chunks, meshes, quads] = await Promise.all([
    stage.getAttribute("data-rendered-chunks"),
    stage.getAttribute("data-rendered-meshes"),
    stage.getAttribute("data-rendered-quads"),
  ]);
  const metrics = {chunks: Number(chunks), meshes: Number(meshes), quads: Number(quads)};
  assert.ok(metrics.chunks > 0 && metrics.meshes > 0 && metrics.quads > 0, `World ready has no rendered geometry: ${JSON.stringify(metrics)}`);
}

async function streamingWorkMetrics(page) {
  const stage = page.locator('[data-app][data-screen="world"]');
  const attributes = {
    residentChunks: "data-resident-chunks",
    terrainPendingChunks: "data-terrain-pending-chunks",
    meshQueuedChunks: "data-mesh-queued-chunks",
    meshActiveChunks: "data-mesh-active-chunks",
    uploadQueuedChunks: "data-upload-queued-chunks",
    translucentSortQueuedMeshes: "data-translucent-sort-queued-meshes",
    pending: "data-render-pending",
  };
  const metrics = {};
  for (const [name, attribute] of Object.entries(attributes)) {
    metrics[name] = Number(await stage.getAttribute(attribute));
    assert.ok(Number.isFinite(metrics[name]) && metrics[name] >= 0, `World streaming metric ${name} is invalid: ${metrics[name]}`);
  }
  return metrics;
}

export async function assertStreamingWorkBounded(page, label) {
  const metrics = await streamingWorkMetrics(page);
  const evidence = `${label}: ${JSON.stringify(metrics)}`;
  // A directional cone contains at most one of each antipodal pair outside
  // its all-direction safety sphere: acquisition <= 33 + (925 - 33) / 2,
  // retention <= 123 + (1419 - 123) / 2. Add one four-section commit surplus.
  // These bounds cover every camera pitch/yaw, not just the axis-aligned view.
  assert.ok(metrics.residentChunks <= 775, `Resident Chunk window grew without bound; ${evidence}`);
  assert.ok(metrics.terrainPendingChunks <= 479, `Terrain request queue grew without bound; ${evidence}`);
  assert.ok(metrics.meshQueuedChunks <= metrics.residentChunks, `Mesh queue contains non-resident Chunks; ${evidence}`);
  assert.ok(metrics.meshActiveChunks <= 2, `Meshing exceeded its Worker budget; ${evidence}`);
  assert.ok(metrics.uploadQueuedChunks <= 2, `GPU upload queue exceeded its producer budget; ${evidence}`);
  assert.ok(metrics.pending <= 1256, `Combined streaming work grew without bound; ${evidence}`);
  return metrics;
}

export async function assertVoxelSceneVisible(page, name, browserFailures) {
  const canvas = page.locator("[data-voxel-canvas]");
  await canvas.waitFor();
  await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))));
  assert.deepEqual(browserFailures, [], "Browser failed before the first rendered world frame");
  await assertVoxelSample(canvas, join(screenshotsDirectory, `${name}-canvas.png`), "Initial voxel sample");
  // Retain both the first usable frame and a settled view at the same camera.
  // This makes partial trees and transient streaming seams visible in review.
  await page.waitForTimeout(2500);
  await assertVoxelSample(canvas, join(screenshotsDirectory, `${name}-canvas-settled.png`), "Settled voxel sample");
}

export async function restoreVoxelContext(page, name) {
  await page.evaluate(async () => {
    const canvas = document.querySelector("[data-voxel-canvas]");
    if (!(canvas instanceof HTMLCanvasElement)) throw new Error("Voxel canvas is unavailable for context restore testing");
    const context = canvas.getContext("webgl2");
    if (context === null) throw new Error("Voxel canvas has no WebGL 2 context");
    const extension = context.getExtension("WEBGL_lose_context");
    if (extension === null) throw new Error("Browser does not expose WEBGL_lose_context for renderer acceptance");
    await new Promise((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error("WebGL context was not restored within 10 seconds")), 10_000);
      canvas.addEventListener("webglcontextlost", (event) => {
        event.preventDefault();
        setTimeout(() => extension.restoreContext(), 80);
      }, {once: true});
      canvas.addEventListener("webglcontextrestored", () => {
        clearTimeout(timeout);
        requestAnimationFrame(() => requestAnimationFrame(resolve));
      }, {once: true});
      extension.loseContext();
    });
  });
  await waitForVoxelSample(
    page.locator("[data-voxel-canvas]"),
    join(screenshotsDirectory, `${name}-canvas-restored.png`),
    "Restored voxel sample",
  );
}

export async function waitForRenderStatus(page, text, timeout) {
  try {
    await page.waitForFunction((expected) => document.querySelector('[data-screen="world"]')
      ?.getAttribute('data-render-status')?.includes(expected), text, {timeout});
  } catch (error) {
    const [statusText, failures] = await Promise.all([
      page.locator('[data-screen="world"]').getAttribute('data-render-status'),
      page.locator("[data-error]").allTextContents(),
    ]);
    throw new Error(`Timed out waiting for render status ${JSON.stringify(text)}; current=${JSON.stringify(statusText)} errors=${JSON.stringify(failures)}`, {cause: error});
  }
}
