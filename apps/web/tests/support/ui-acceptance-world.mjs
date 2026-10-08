import assert from "node:assert/strict";
import {writeFile} from "node:fs/promises";
import {join} from "node:path";
import {screenshotsDirectory} from "./ui-acceptance-paths.mjs";
import {boundedOperation} from "./ui-acceptance-runtime.mjs";
import {assertRenderedGeometry, assertStreamingWorkBounded, waitForRenderStatus} from "./ui-acceptance-visual.mjs";

export async function waitForWorkerCount(page, expected, label) {
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    if (page.workers().length === expected) return;
    await page.waitForTimeout(50);
  }
  assert.equal(page.workers().length, expected, `${label} leaked a dedicated Worker`);
}

async function holdNextWorkerScript(page, scriptName) {
  const pattern = `**/${scriptName}`;
  let requested = false;
  let released = false;
  let startRequest;
  let releaseRequest;
  let finishRequest;
  const started = new Promise((resolve) => { startRequest = resolve; });
  const gate = new Promise((resolve) => { releaseRequest = resolve; });
  const finished = new Promise((resolve) => { finishRequest = resolve; });
  const handler = async (route) => {
    requested = true;
    startRequest();
    await gate;
    try {
      await route.continue();
    } finally {
      finishRequest();
    }
  };
  await page.route(pattern, handler, {times: 1});
  return {
    async waitUntilRequested() {
      await boundedOperation(`${scriptName} request`, 60_000, () => started);
    },
    async release() {
      if (released) return;
      released = true;
      releaseRequest();
      if (requested) await boundedOperation(`${scriptName} continuation`, 15_000, () => finished);
      await page.unroute(pattern, handler);
    },
  };
}

async function fillWorldCreation(page, world) {
  await page.locator('[data-screen="create-world"]').waitFor();
  await page.locator('[data-world-name-input]').fill(world.name);
  await page.locator(`[data-preset="${world.preset}"]`).click();
  await page.locator(`[data-mode="${world.mode.toLowerCase()}"]`).click();
  await page.locator('[data-seed-input]').fill(world.seed);
  await page.locator('[data-advanced-settings]').click();
  await page.locator('[data-world-id-input]').fill(world.id);
}

export async function createWorld(page, world, {waitForRendering = true} = {}) {
  await fillWorldCreation(page, world);
  await page.locator('[data-create-world]').click();
  await page.waitForURL((url) => url.pathname === `/world/${encodeURIComponent(world.id)}`);
  await page.locator('[data-world-ready="true"]').waitFor({ timeout: 60_000 });
  assert.equal(await page.locator('[data-error]').count(), 0);
  if (!waitForRendering) return;
  await waitForRenderStatus(page, "World ready", 120_000);
  assert.equal(await page.locator('[data-error]').count(), 0);
  await assertRenderedGeometry(page);
}

export async function aimAtCreativeGround(page) {
  const canvas = page.locator('[data-voxel-canvas]');
  await canvas.click({position: {x: 320, y: 240}});
  await page.locator('[data-voxel-canvas][data-pointer-locked="true"]').waitFor({timeout: 10_000});
  await page.mouse.move(320, 690);
  await page.locator('[data-creative-target-runtime-id]').waitFor({timeout: 10_000});
  return page.locator('[data-screen="world"]').evaluate((stage) => ({
    x: Number(stage.getAttribute('data-creative-target-x')),
    y: Number(stage.getAttribute('data-creative-target-y')),
    z: Number(stage.getAttribute('data-creative-target-z')),
    runtimeId: Number(stage.getAttribute('data-creative-target-runtime-id')),
  }));
}

export async function editCreativeGround(page) {
  assert.equal(await page.locator('[data-creative-toolbar] [data-creative-slot]').count(), 9);
  await page.waitForFunction(() => {
    const previews = [...document.querySelectorAll('[data-creative-toolbar] img')];
    return previews.length === 9 && previews.every((image) => image.complete && image.naturalWidth > 0);
  }, null, {timeout: 10_000});
  const original = await aimAtCreativeGround(page);
  await page.keyboard.press('3');
  await page.locator('[data-creative-slot="3"][data-selected="true"]').waitFor();
  await page.mouse.click(320, 690, {button: 'left'});
  await page.waitForFunction((before) => {
    const stage = document.querySelector('[data-screen="world"]');
    return stage?.hasAttribute('data-creative-target-runtime-id') && (
      stage.getAttribute('data-creative-target-x') !== String(before.x)
      || stage.getAttribute('data-creative-target-y') !== String(before.y)
      || stage.getAttribute('data-creative-target-z') !== String(before.z)
    );
  }, original, {timeout: 10_000});
  assert.equal(await page.locator('[data-creative-edit-error]').count(), 0);
  await page.mouse.click(320, 690, {button: 'right'});
  await page.waitForFunction((before) => {
    const stage = document.querySelector('[data-screen="world"]');
    return stage?.getAttribute('data-creative-target-x') === String(before.x)
      && stage.getAttribute('data-creative-target-y') === String(before.y)
      && stage.getAttribute('data-creative-target-z') === String(before.z)
      && stage.getAttribute('data-creative-target-runtime-id') === '121';
  }, original, {timeout: 10_000});
  assert.equal(await page.locator('[data-creative-edit-error]').count(), 0);
  return original;
}

export async function worldUnloadIsGuarded(page) {
  return page.evaluate(() => {
    const event = new Event("beforeunload", {cancelable: true});
    const allowed = window.dispatchEvent(event);
    return {allowed, defaultPrevented: event.defaultPrevented};
  });
}

export async function waitForWorldExitDialog(page) {
  const dialog = page.locator('[data-world-exit-dialog]');
  await dialog.waitFor({state: "visible"});
  assert.equal(await dialog.getAttribute("data-world-exit-pending"), "false");
  assert.equal(await page.locator('[data-stay-in-world]').isEnabled(), true);
  assert.equal(await page.locator('[data-confirm-leave-world]').isEnabled(), true);
  return dialog;
}

export async function cancelWorldExit(page) {
  const dialog = await waitForWorldExitDialog(page);
  await page.locator('[data-stay-in-world]').click();
  await dialog.waitFor({state: "hidden"});
  await page.locator('[data-app][data-screen="world"]').waitFor();
}

export async function confirmWorldExit(page) {
  await waitForWorldExitDialog(page);
  await page.locator('[data-confirm-leave-world]').click();
}

export async function leaveWorldToHome(page) {
  await page.locator('[data-open-settings]').click();
  await page.locator('[data-leave-world]').click();
  await confirmWorldExit(page);
  await page.locator('[data-app][data-screen="world-home"]').waitFor();
}

export async function cancelCreateWhilePending(page, world, browserFailures) {
  await fillWorldCreation(page, world);
  const workerCount = page.workers().length;
  const heldWorker = await holdNextWorkerScript(page, "local-worker.js");
  try {
    await page.locator('[data-create-world]').click();
    await heldWorker.waitUntilRequested();
    await page.locator('[data-cancel-world-loading]').click();
    await page.locator('[data-empty-worlds]').waitFor();
  } finally {
    await heldWorker.release();
  }
  await waitForWorkerCount(page, workerCount, "Cancelled world creation");
  await page.waitForTimeout(100);
  assert.equal(new URL(page.url()).pathname, "/", "Cancelled world creation navigated after its page was destroyed");
  assert.equal(await page.locator('[data-play-world]').count(), 0, "Cancelled world creation published a saved world");
  assert.deepEqual(browserFailures, [], "Cancelled world creation reported an unowned browser failure");
}

export async function cancelOpenWhilePending(page, worldId, browserFailures) {
  await page.locator('[data-open-existing-world]').click();
  await page.locator('[data-screen="open-world"]').waitFor();
  await page.locator('[data-open-world-id]').fill(worldId);
  const workerCount = page.workers().length;
  const heldWorker = await holdNextWorkerScript(page, "local-worker.js");
  try {
    await page.locator('[data-open-world]').click();
    await heldWorker.waitUntilRequested();
    await page.locator('[data-back-home]').click();
    await page.locator('[data-empty-worlds]').waitFor();
  } finally {
    await heldWorker.release();
  }
  await waitForWorkerCount(page, workerCount, "Cancelled world opening");
  await page.waitForTimeout(100);
  assert.equal(new URL(page.url()).pathname, "/", "Cancelled world opening navigated after its page was destroyed");
  assert.equal(await page.locator('[data-error]').count(), 0, "Cancelled world opening wrote an error into the next page");
  assert.deepEqual(browserFailures, [], "Cancelled world opening reported an unowned browser failure");
}

export async function cancelWorldEntryWhileLoading(page, world, browserFailures) {
  const workerCount = page.workers().length;
  const heldWorker = await holdNextWorkerScript(page, "meshing-worker.js");
  try {
    await page.locator('[data-play-world]').click();
    await page.waitForURL((url) => url.pathname === `/world/${encodeURIComponent(world.id)}`);
    await page.locator('[data-world-loading]').waitFor();
    await heldWorker.waitUntilRequested();
    assert.deepEqual(await worldUnloadIsGuarded(page), {allowed: true, defaultPrevented: false});
    await page.locator('[data-cancel-world-loading]').click();
    await page.locator('[data-screen="world-home"]').waitFor();
    assert.equal(await page.locator('[data-world-exit-dialog][open]').count(), 0);
  } finally {
    await heldWorker.release();
  }
  await page.locator('[data-selected-world-name]').filter({hasText: world.name}).waitFor();
  await waitForWorkerCount(page, workerCount, "Cancelled world entry");
  await page.waitForTimeout(100);
  assert.equal(new URL(page.url()).pathname, "/", "Cancelled world entry navigated after its page was destroyed");
  assert.deepEqual(browserFailures, [], "Cancelled world entry reported an unowned browser failure");
}

async function viewChunk(page) {
  return page.locator('[data-voxel-canvas]').evaluate((element) => ({
    x: Number(element.getAttribute("data-view-chunk-x")),
    y: Number(element.getAttribute("data-view-chunk-y")),
    z: Number(element.getAttribute("data-view-chunk-z")),
  }));
}

async function waitForViewChunkChange(page, before, axes) {
  await page.waitForFunction(({before, axes}) => {
    const element = document.querySelector('[data-voxel-canvas]');
    if (!(element instanceof HTMLCanvasElement)) return false;
    const current = {
      x: Number(element.getAttribute("data-view-chunk-x")),
      y: Number(element.getAttribute("data-view-chunk-y")),
      z: Number(element.getAttribute("data-view-chunk-z")),
    };
    return axes.some((axis) => current[axis] !== before[axis]);
  }, {before, axes}, {timeout: 15_000});
}

async function startFrameSampling(page) {
  await page.evaluate(() => {
    const probe = {active: true, previous: null, intervals: [], gaps: [], longFrames: [], observer: null,
      longAnimationFramesSupported: PerformanceObserver.supportedEntryTypes.includes("long-animation-frame")};
    if (probe.longAnimationFramesSupported) {
      probe.recordLongFrames = (entries) => {
        for (const entry of entries) {
          probe.longFrames.push({
            duration: entry.duration,
            blockingDuration: entry.blockingDuration,
            scripts: entry.scripts.map((script) => ({
              duration: script.duration,
              invoker: script.invoker,
              function: script.sourceFunctionName,
              source: script.sourceURL.replace(location.origin, ""),
              position: script.sourceCharPosition,
            })).sort((a, b) => b.duration - a.duration).slice(0, 3),
          });
        }
      };
      probe.observer = new PerformanceObserver((entries) => probe.recordLongFrames(entries.getEntries()));
      probe.observer.observe({type: "long-animation-frame"});
    }
    globalThis.__openVoxelUiFrameProbe = probe;
    const sample = (now) => {
      if (!probe.active) return;
      if (probe.previous !== null) {
        const duration = now - probe.previous;
        probe.intervals.push(duration);
        if (duration > 50) probe.gaps.push({start: probe.previous, end: now, duration, visibility: document.visibilityState});
      }
      probe.previous = now;
      requestAnimationFrame(sample);
    };
    requestAnimationFrame(sample);
  });
}

async function finishFrameSampling(page) {
  return page.evaluate(() => {
    const probe = globalThis.__openVoxelUiFrameProbe;
    if (probe === undefined) throw new Error("World movement frame probe is unavailable");
    probe.active = false;
    if (probe.observer !== null) {
      probe.recordLongFrames(probe.observer.takeRecords());
      probe.observer.disconnect();
    }
    delete globalThis.__openVoxelUiFrameProbe;
    const intervals = probe.intervals.filter((value) => Number.isFinite(value) && value >= 0).sort((left, right) => left - right);
    if (intervals.length === 0) throw new Error("World movement frame probe observed no frames");
    const percentile95 = intervals[Math.min(intervals.length - 1, Math.floor(intervals.length * 0.95))];
    return {
      frames: intervals.length,
      percentile95Milliseconds: percentile95,
      maximumMilliseconds: intervals.at(-1),
      over50Milliseconds: intervals.filter((value) => value > 50).length,
      longestIntervals: probe.gaps.sort((a, b) => b.duration - a.duration).slice(0, 3),
      longAnimationFramesSupported: probe.longAnimationFramesSupported,
      longestFrames: probe.longFrames.sort((a, b) => b.duration - a.duration).slice(0, 3),
    };
  });
}

export async function moveFirstPersonWorld(page, graphics, observationHeight) {
  const canvas = page.locator('[data-voxel-canvas]');
  assert.equal(await canvas.getAttribute("data-navigation-mode"), "first-person");
  assert.equal(await canvas.getAttribute("data-movement-mode"), "creative-flight");
  assert.equal(await page.locator('[data-world-chrome] button').count(), 1);
  assert.equal(await page.locator('[data-creative-toolbar] img').count(), 9);
  const beforeHorizontal = await viewChunk(page);
  const streamingStarted = page.waitForFunction(() => {
    const stage = document.querySelector('[data-app][data-screen="world"]');
    return stage !== null && Number(stage.getAttribute("data-render-pending")) > 0;
  }, null, {timeout: 60_000});
  await canvas.click({position: {x: 320, y: 240}});
  await page.locator('[data-voxel-canvas][data-pointer-locked="true"]').waitFor({timeout: 10_000});
  await page.mouse.move(1040, 360);
  await page.keyboard.down("Shift");
  await page.keyboard.down("w");
  try {
    await waitForViewChunkChange(page, beforeHorizontal, ["x", "z"]);
  } finally {
    await page.keyboard.up("w");
    await page.keyboard.up("Shift");
  }
  await streamingStarted;
  await assertStreamingWorkBounded(page, "Horizontal movement");

  // Keep moving across several more boundaries. This catches distance-based
  // growth that a single transition cannot expose while retaining a compact
  // headless acceptance duration.
  const profiler = process.env.OPENVOXEL_PROFILE_FRAMES === "1" ? await page.context().newCDPSession(page) : null;
  if (profiler !== null) {
    await profiler.send("Profiler.enable");
    await profiler.send("Profiler.start");
  }
  await startFrameSampling(page);
  await page.keyboard.down("Shift");
  await page.keyboard.down("w");
  try {
    await page.waitForFunction(() => Number(document.querySelector("[data-map-canvas]")?.getAttribute("data-map-frames")) > 0);
    const mapSamples = await page.evaluate(async () => {
      const map = document.querySelector("[data-map-canvas]");
      const samples = [];
      for (let index = 0; index < 18; index += 1) {
        await new Promise(resolve => requestAnimationFrame(resolve));
        samples.push({
          x: Number(map.getAttribute("data-map-x")),
          z: Number(map.getAttribute("data-map-z")),
          captures: Number(map.getAttribute("data-map-frames")),
        });
      }
      return samples;
    });
    assert.ok(mapSamples.some((sample, index) => index > 0
      && sample.captures === mapSamples[index - 1].captures
      && Math.hypot(sample.x - mapSamples[index - 1].x, sample.z - mapSamples[index - 1].z) > 0.001),
    "Minimap must follow movement between terrain captures");
    await page.waitForFunction((origin) => {
      const element = document.querySelector('[data-voxel-canvas]');
      if (!(element instanceof HTMLCanvasElement)) return false;
      const dx = Math.abs(Number(element.getAttribute("data-view-chunk-x")) - origin.x);
      const dz = Math.abs(Number(element.getAttribute("data-view-chunk-z")) - origin.z);
      return Math.max(dx, dz) >= 8;
    }, beforeHorizontal, {timeout: 30_000});
  } finally {
    await page.keyboard.up("w");
    await page.keyboard.up("Shift");
  }
  const travelFrames = await finishFrameSampling(page);
  if (profiler !== null) {
    const {profile} = await profiler.send("Profiler.stop");
    await writeFile(join(screenshotsDirectory, "movement.cpuprofile"), JSON.stringify(profile));
    await profiler.detach();
  }
  assert.ok(travelFrames.frames >= 2, `Long-distance movement rendered too few frames: ${JSON.stringify(travelFrames)}`);
  if (graphics.accelerated) {
    assert.ok(travelFrames.percentile95Milliseconds <= 120, `Long-distance movement exceeded the accelerated-GPU p95 frame budget: ${JSON.stringify(travelFrames)}`);
    assert.ok(travelFrames.maximumMilliseconds <= 750, `Long-distance movement stalled on an accelerated GPU: ${JSON.stringify(travelFrames)}`);
  } else {
    // SwiftShader validates progress and bounded work, not production frame
    // pacing. Keep a broad liveness ceiling so an accidental synchronous
    // workload still fails without treating CPU rasterization as a GPU budget.
    assert.ok(travelFrames.percentile95Milliseconds <= 500, `Software-rendered movement lost bounded progress: ${JSON.stringify(travelFrames)}`);
    assert.ok(travelFrames.maximumMilliseconds <= 2_500, `Software-rendered movement stopped making progress: ${JSON.stringify(travelFrames)}`);
  }
  const travelWork = await assertStreamingWorkBounded(page, "Eight-Chunk movement");
  process.stdout.write(`World movement sample graphics=${JSON.stringify(graphics)} frames=${JSON.stringify(travelFrames)} work=${JSON.stringify(travelWork)}\n`);

  const beforeRise = await viewChunk(page);
  await page.keyboard.down("Shift");
  await page.keyboard.down("Space");
  try {
    await waitForViewChunkChange(page, beforeRise, ["y"]);
  } finally {
    await page.keyboard.up("Space");
    await page.keyboard.up("Shift");
  }
  const raised = await viewChunk(page);
  assert.ok(raised.y > beforeRise.y, "First-person Space input did not raise the camera");

  // Let the pure braking phase settle the upward velocity before asking for
  // the opposite direction; the assertion then identifies descending input
  // instead of merely observing reduced ascent.
  await page.waitForTimeout(600);
  await page.keyboard.down("Shift");
  await page.keyboard.down("Control");
  try {
    await page.waitForFunction((raisedY) => {
      const element = document.querySelector('[data-voxel-canvas]');
      return element instanceof HTMLCanvasElement && Number(element.getAttribute("data-view-chunk-y")) < raisedY;
    }, raised.y, {timeout: 15_000});
  } finally {
    await page.keyboard.up("Control");
    await page.keyboard.up("Shift");
  }

  // Creative flight can cross terrain while exploring at the spawn height.
  // After proving descent, establish this fixture's clear observation height
  // and look down before asserting pixels at the fully streamed destination.
  await page.keyboard.down("Space");
  try {
    await page.waitForFunction((height) => {
      const element = document.querySelector('[data-voxel-canvas]');
      return element instanceof HTMLCanvasElement && Number(element.getAttribute("data-view-y")) >= height;
    }, observationHeight, {timeout: 15_000});
  } finally {
    await page.keyboard.up("Space");
  }
  await page.mouse.move(1040, 560);

  await page.keyboard.press("Escape");
  await page.locator('[data-voxel-canvas][data-pointer-locked="false"]').waitFor({timeout: 10_000});
  assert.equal(await page.locator('[data-world-exit-dialog]').isVisible(), false, "Escape opened the world exit confirmation");
  const afterEscape = await viewChunk(page);
  await page.keyboard.down("Shift");
  await page.keyboard.down("w");
  await page.waitForTimeout(1_200);
  await page.keyboard.up("w");
  await page.keyboard.up("Shift");
  assert.deepEqual(await viewChunk(page), afterEscape, "First-person movement remained active after Escape released Pointer Lock");
  await assertStreamingWorkBounded(page, "Released first-person movement");
  assert.deepEqual(await page.locator('[data-error]').allTextContents(), []);
  // Stopping must let the latest view converge, including missing sections at
  // the destination; merely keeping a small resident count is not sufficient.
  await page.waitForFunction(() => {
    const stage = document.querySelector('[data-app][data-screen="world"]');
    return stage !== null && Number(stage.getAttribute("data-render-pending")) === 0;
  }, null, {timeout: 120_000});
  await assertStreamingWorkBounded(page, "Settled destination");
  await assertRenderedGeometry(page);
}

export async function assertWorldHasSurvivalWalk(page) {
  const canvas = page.locator('[data-voxel-canvas]');
  await page.locator('[data-world-ready="true"]').waitFor({timeout: 120_000});
  await waitForRenderStatus(page, "World ready", 120_000);
  assert.equal(await canvas.getAttribute("data-navigation-mode"), "first-person");
  assert.equal(await canvas.getAttribute("data-movement-mode"), "survival-walk");
  assert.equal(await page.locator('[data-world-chrome] button').count(), 1);
  assert.equal(await page.locator('[data-creative-toolbar]').count(), 0);
  await page.waitForFunction(() => {
    const element = document.querySelector('[data-voxel-canvas]');
    return element instanceof HTMLCanvasElement
      && element.getAttribute("data-player-grounded") === "true"
      && Number(element.getAttribute("data-view-y")) > 10;
  }, null, {timeout: 15_000});

  const standingY = Number(await canvas.getAttribute("data-view-y"));
  const before = await viewChunk(page);
  await canvas.click({position: {x: 320, y: 240}});
  await page.locator('[data-voxel-canvas][data-pointer-locked="true"]').waitFor({timeout: 10_000});
  await page.keyboard.down("Space");
  await page.waitForFunction((originY) => {
    const element = document.querySelector('[data-voxel-canvas]');
    return element instanceof HTMLCanvasElement && Number(element.getAttribute("data-view-y")) > originY + 0.2;
  }, standingY, {timeout: 5_000});
  await page.keyboard.up("Space");
  await page.waitForFunction((originY) => {
    const element = document.querySelector('[data-voxel-canvas]');
    if (!(element instanceof HTMLCanvasElement)) return false;
    const y = Number(element.getAttribute("data-view-y"));
    return element.getAttribute("data-player-grounded") === "true" && Math.abs(y - originY) < 0.05;
  }, standingY, {timeout: 10_000});

  await page.keyboard.down("Shift");
  await page.keyboard.down("w");
  try {
    await waitForViewChunkChange(page, before, ["x", "z"]);
  } finally {
    await page.keyboard.up("w");
    await page.keyboard.up("Shift");
  }
  await page.keyboard.press("Escape");
  await page.locator('[data-voxel-canvas][data-pointer-locked="false"]').waitFor({timeout: 10_000});
  assert.equal(await page.locator('[data-world-exit-dialog]').isVisible(), false, "Escape opened the world exit confirmation");
  assert.deepEqual(await page.locator('[data-error]').allTextContents(), []);
}
