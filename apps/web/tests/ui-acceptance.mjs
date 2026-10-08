import assert from "node:assert/strict";
import {mkdir, readFile, rm} from "node:fs/promises";
import {join} from "node:path";
import {chromium} from "playwright";
import {assertWorldMinimap} from "./support/minimap-acceptance.mjs";
import {builtHtmlPath, screenshotsDirectory} from "./support/ui-acceptance-paths.mjs";
import {assertBuildPerformance} from "./support/ui-acceptance-performance.mjs";
import {availablePort, attemptCleanup, boundedOperation, graphicsBackend, processes, reportCleanupFailures, requireSuccess, start, stop, waitForUrl} from "./support/ui-acceptance-runtime.mjs";
import {assertVoxelSample, assertVoxelSceneVisible, dispatchCarouselWheel, restoreVoxelContext, screenshot} from "./support/ui-acceptance-visual.mjs";
import {aimAtCreativeGround, assertWorldHasSurvivalWalk, cancelCreateWhilePending, cancelOpenWhilePending, cancelWorldEntryWhileLoading, cancelWorldExit, confirmWorldExit, createWorld, editCreativeGround, leaveWorldToHome, moveFirstPersonWorld, waitForWorkerCount, waitForWorldExitDialog, worldUnloadIsGuarded} from "./support/ui-acceptance-world.mjs";

const buildTimeoutMs = 120_000;
const browserCloseTimeoutMs = 15_000;
const noFailure = Symbol("no failure");

let browser = null;
let mainFailure = noFailure;
const cleanupFailures = [];
try {
  await rm(screenshotsDirectory, { recursive: true, force: true });
  await mkdir(screenshotsDirectory, { recursive: true });
  if (!process.argv.includes("--reuse-build")) {
    await requireSuccess(start("Web build", ["build", "apps/web"]), buildTimeoutMs);
  }
  await assertBuildPerformance();
  const expectedHtml = await readFile(builtHtmlPath, "utf8");
  assert.match(expectedHtml, /<title>OpenVoxel<\/title>/u, "This run's Web build is not the OpenVoxel page");
  assert.match(expectedHtml, /<div id="app"><\/div>/u, "This run's Web build has no OpenVoxel application mount");

  const previewPort = await availablePort();
  const previewUrl = `http://127.0.0.1:${previewPort}/`;
  const preview = start("Web preview", ["preview", "apps/web", "--port", `${previewPort}`]);
  await waitForUrl(previewUrl, preview, expectedHtml);

  // Chromium otherwise forces SwiftShader in headless mode on macOS even when
  // a Metal device is available, which turns the frame budget into a CPU
  // rasterizer benchmark. Prefer the production GPU path and detect fallback.
  browser = await chromium.launch({headless: true, args: ["--enable-gpu"]});
  const graphics = await graphicsBackend(browser);
  const context = await browser.newContext({ viewport: { width: 1536, height: 1024 }, deviceScaleFactor: 1 });
  // Chromium's headless backend exposes Pointer Lock methods but never grants
  // a lock. Keep the product path unchanged and emulate only the browser-owned
  // lock state so the adapter's capture, mousemove, Escape and cleanup contract
  // remains executable in CI.
  await context.addInitScript(() => {
    localStorage.setItem("openvoxel.settings.v1", JSON.stringify({renderBackend: "webgl"}));
    window.__openVoxelAudioContexts = [];
    window.__openVoxelDecodedAudio = 0;
    window.AudioContext = new Proxy(window.AudioContext, {
      construct(target, args) {
        const audio = Reflect.construct(target, args);
        const decode = audio.decodeAudioData.bind(audio);
        audio.decodeAudioData = (...values) => decode(...values).then(buffer => {
          window.__openVoxelDecodedAudio += 1;
          return buffer;
        });
        window.__openVoxelAudioContexts.push(audio);
        return audio;
      },
    });
    let lockedElement = null;
    Object.defineProperty(document, "pointerLockElement", {
      configurable: true,
      get: () => lockedElement,
    });
    Object.defineProperty(HTMLCanvasElement.prototype, "requestPointerLock", {
      configurable: true,
      value() {
        lockedElement = this;
        document.dispatchEvent(new Event("pointerlockchange"));
        return Promise.resolve();
      },
    });
    Object.defineProperty(document, "exitPointerLock", {
      configurable: true,
      value() {
        if (lockedElement === null) return;
        lockedElement = null;
        document.dispatchEvent(new Event("pointerlockchange"));
      },
    });
    window.addEventListener("keydown", (event) => {
      if (event.code === "Escape" && lockedElement !== null) document.exitPointerLock();
    }, true);
  });
  const page = await context.newPage();
  const browserFailures = [];
  page.on("pageerror", (error) => browserFailures.push(`pageerror: ${error.message}`));
  page.on("console", (message) => {
    if (message.type() === "error") browserFailures.push(`console: ${message.text()}`);
  });

  await page.goto(previewUrl, { waitUntil: "networkidle" });
  assert.equal(await page.title(), "OpenVoxel", "Preview navigation did not load this run's OpenVoxel home page");
  await page.locator('[data-app][data-screen="world-home"]').waitFor();
  assert.equal(await page.evaluate(() => performance.getEntriesByType("resource")
    .some((entry) => entry.name.includes("/assets/chunk-world-page-"))), false,
  "Home page eagerly downloaded the world route");
  await page.locator('[data-empty-worlds]').waitFor();
  assert.equal(await page.locator('[data-play-world]').count(), 0);
  assert.equal(await dispatchCarouselWheel(page, {deltaY: 180}), false, "Empty carousel consumed page scrolling");
  await screenshot(page, "01-empty");

  await page.locator('[data-create-first-world]').click();
  await screenshot(page, "02-create");

  const suffix = Date.now();
  const cancelled = {
    id: `cancelled-world-${suffix}`,
    name: "Cancelled World",
    preset: "meadow",
    mode: "Creative",
    seed: "ui-cancel-lifecycle-v1",
  };
  await cancelCreateWhilePending(page, cancelled, browserFailures);
  await cancelOpenWhilePending(page, cancelled.id, browserFailures);
  await page.locator('[data-create-first-world]').click();

  const coast = {
    // Keep reserved delimiters in the authoritative id: navigation must encode
    // them into one path segment and Router must decode the original key again.
    id: `coastal/sandbox?spawn#${suffix}%`,
    name: "Coastal Sandbox",
    preset: "coast",
    mode: "Creative",
    seed: "ui-coast-visual-v1",
    // This route ends above the seed's 76–77-block coastal terrain.
    observationHeight: 96,
  };
  await createWorld(page, coast);
  assert.equal(await page.evaluate(() => performance.getEntriesByType("resource")
    .some((entry) => entry.name.includes("/assets/chunk-world-page-"))), true,
  "Entering a world did not load the lazy world route");
  await assertVoxelSceneVisible(page, "03-world", browserFailures);
  const editedBlock = await editCreativeGround(page);
  await page.waitForFunction(() => window.__openVoxelAudioContexts?.[0]?.state === "running", null, {timeout: 10_000});
  await page.waitForFunction(() => window.__openVoxelDecodedAudio >= 3, null, {timeout: 10_000});
  assert.equal(await page.evaluate(() => window.__openVoxelAudioContexts.length), 1,
    "One world should own one audio context");
  // Measure ordinary exploration before deliberately destroying the graphics
  // context; recovery is then checked against the fully populated destination.
  await moveFirstPersonWorld(page, graphics, coast.observationHeight);
  await assertWorldMinimap(page, screenshotsDirectory);
  await assertVoxelSample(
    page.locator("[data-voxel-canvas]"),
    join(screenshotsDirectory, "03-world-canvas-moved.png"),
    "Moved voxel sample",
  );
  await restoreVoxelContext(page, "03-world");
  await assertWorldMinimap(page, screenshotsDirectory);
  await screenshot(page, "03-world");
  for (const width of [375, 320]) {
    await page.setViewportSize({width, height: 812});
    const narrowHud = await page.evaluate(() => {
      const chrome = document.querySelector('[data-world-chrome]').getBoundingClientRect();
      const minimap = document.querySelector('[data-minimap]').getBoundingClientRect();
      const toolbar = document.querySelector('[data-creative-toolbar]').getBoundingClientRect();
      return {chromeLeft: chrome.left, minimapRight: minimap.right, toolbarLeft: toolbar.left, toolbarRight: toolbar.right};
    });
    assert.ok(narrowHud.minimapRight <= narrowHud.chromeLeft, `HUD overlaps the minimap at ${width}px`);
    assert.ok(narrowHud.toolbarLeft >= 0 && narrowHud.toolbarRight <= width, `Creative toolbar leaves the ${width}px viewport`);
    await screenshot(page, `03-world-${width}px`);
  }
  await page.setViewportSize({width: 1536, height: 1024});

  assert.deepEqual(await worldUnloadIsGuarded(page), {allowed: false, defaultPrevented: true});
  const protectedWorldUrl = page.url();
  await page.evaluate(() => history.back());
  await waitForWorldExitDialog(page);
  assert.equal(page.url(), protectedWorldUrl, "Cancelled history navigation did not restore the protected world URL");
  await cancelWorldExit(page);
  assert.equal(page.url(), protectedWorldUrl, "Cancelling history navigation left the world");

  await page.locator('[data-open-settings]').click();
  await page.locator('[data-leave-world]').click();
  await waitForWorldExitDialog(page);
  await screenshot(page, "03-world-exit-confirmation");
  await cancelWorldExit(page);

  await page.evaluate(() => history.back());
  await confirmWorldExit(page);
  await page.waitForFunction(() => document.querySelector('[data-screen]')?.getAttribute("data-screen") !== "world");
  await page.waitForFunction(() => window.__openVoxelAudioContexts?.[0]?.state === "closed", null, {timeout: 10_000});
  assert.deepEqual(await worldUnloadIsGuarded(page), {allowed: true, defaultPrevented: false});
  if (await page.locator('[data-screen="world-home"]').count() === 0) {
    await page.locator('[data-back-home]').click();
  }
  await page.locator('[data-selected-world-name]').filter({hasText: coast.name}).waitFor();
  await waitForWorkerCount(page, 0, "World exit");
  assert.equal(await dispatchCarouselWheel(page, {deltaY: 180}), false, "Single-world carousel consumed page scrolling");
  await screenshot(page, "04-populated");
  await cancelWorldEntryWhileLoading(page, coast, browserFailures);

  await page.goto(new URL(`/world/${encodeURIComponent(coast.id)}`, previewUrl).href, {waitUntil: "networkidle"});
  await page.locator('[data-world-ready="true"]').waitFor({timeout: 60_000});
  assert.equal(await page.locator('[data-voxel-canvas]').getAttribute("data-navigation-mode"), "first-person");
  assert.equal(await page.locator('[data-world-chrome] button').count(), 1);
  assert.equal(await page.locator('[data-creative-toolbar] img').count(), 9);
  const reopenedBlock = await aimAtCreativeGround(page);
  assert.deepEqual(reopenedBlock, {...editedBlock, runtimeId: 121}, "Creative edit did not survive closing and reopening the world");
  assert.deepEqual(await worldUnloadIsGuarded(page), {allowed: false, defaultPrevented: true});
  await leaveWorldToHome(page);
  await page.locator('[data-selected-world-name]').filter({hasText: coast.name}).waitFor();
  assert.deepEqual(await worldUnloadIsGuarded(page), {allowed: true, defaultPrevented: false});

  await page.locator('[data-new-world]').click();
  const highlands = {
    id: `highland-realm-${suffix}`,
    name: "Highland Realm",
    preset: "highlands",
    mode: "Survival",
    seed: "high-clouds",
  };
  await createWorld(page, highlands);
  await assertWorldHasSurvivalWalk(page);
  await leaveWorldToHome(page);
  await page.locator('[data-selected-world-name]').filter({ hasText: highlands.name }).waitFor();
  assert.equal(await page.locator('[data-carousel-dot]').count(), 0);
  await page.locator('[data-carousel-previous]').click();
  await page.locator('[data-selected-world-name]').filter({hasText: coast.name}).waitFor();
  for (const gesture of [{ctrlKey: true, deltaY: 180}, {metaKey: true, deltaY: 180}, {deltaY: 180}]) {
    assert.equal(await dispatchCarouselWheel(page, gesture), false);
  }
  await page.locator('[data-selected-world-name]').filter({hasText: coast.name}).waitFor();
  await page.locator('[data-carousel-next]').click();
  await page.locator('[data-selected-world-name]').filter({hasText: highlands.name}).waitFor();

  assert.deepEqual(browserFailures, []);
  await assertBuildPerformance();
} catch (error) {
  mainFailure = error;
} finally {
  if (browser !== null) {
    await attemptCleanup(cleanupFailures, "Web browser close", () => (
      boundedOperation("Web browser close", browserCloseTimeoutMs, () => browser.close())
    ));
  }
  for (const processInfo of [...processes].reverse()) {
    await attemptCleanup(cleanupFailures, `${processInfo.name} stop`, () => stop(processInfo));
  }
}

if (mainFailure !== noFailure) {
  reportCleanupFailures("Web UI acceptance failure", cleanupFailures);
  throw mainFailure;
}
if (cleanupFailures.length > 0) throw new AggregateError(cleanupFailures, "Web UI acceptance cleanup failed");
console.log(`Web UI acceptance passed; screenshots: ${screenshotsDirectory}`);
