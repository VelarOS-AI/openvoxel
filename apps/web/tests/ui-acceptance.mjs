import assert from "node:assert/strict";
import { mkdir, readFile } from "node:fs/promises";
import { createServer } from "node:net";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";
import { chromium } from "playwright";
import sharp from "sharp";

const projectRoot = fileURLToPath(new URL("../../../", import.meta.url));
const velarCli = join(projectRoot, "node_modules", "@velarscript", "cli", "dist", "cli.js");
const screenshotsDirectory = join(projectRoot, "apps", "web", "generated", "ui-acceptance");
const resourcePackPath = join(projectRoot, "packages", "client", "rendering", "generated", "client-resource-pack.json");
const processes = [];

async function portIsAvailable(port) {
  const server = createServer();
  const listening = await new Promise((resolve, reject) => {
    server.once("error", (error) => error?.code === "EADDRINUSE" ? resolve(false) : reject(error));
    server.listen(port, "127.0.0.1", () => resolve(true));
  });
  if (!listening) return false;
  await new Promise((resolve, reject) => server.close((error) => error === undefined ? resolve() : reject(error)));
  return true;
}

async function availablePort() {
  for (const port of [7273, 7274, 7275]) {
    if (await portIsAvailable(port)) return port;
  }
  throw new Error("Web UI acceptance requires an available preview port (7273, 7274, or 7275)");
}

function start(name, args) {
  const output = [];
  const child = spawn(process.execPath, [velarCli, ...args], {
    cwd: projectRoot,
    env: process.env,
    stdio: ["ignore", "pipe", "pipe"],
  });
  for (const stream of [child.stdout, child.stderr]) {
    stream.setEncoding("utf8");
    stream.on("data", (chunk) => {
      output.push(chunk);
      if (output.length > 100) output.shift();
    });
  }
  const processInfo = { name, child, output };
  processes.push(processInfo);
  return processInfo;
}

function processFailure(processInfo) {
  return `${processInfo.name} exited before it became ready:\n${processInfo.output.join("")}`;
}

async function requireSuccess(processInfo) {
  await new Promise((resolve, reject) => {
    processInfo.child.once("error", reject);
    processInfo.child.once("exit", (code) => code === 0 ? resolve() : reject(new Error(processFailure(processInfo))));
  });
}

async function waitForUrl(url, processInfo) {
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    if (processInfo.child.exitCode !== null) throw new Error(processFailure(processInfo));
    try {
      const response = await fetch(url);
      if (response.ok) return;
    } catch {
      // Preview is still starting.
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`${processInfo.name} did not become ready at ${url}`);
}

async function stop(processInfo) {
  if (processInfo.child.exitCode !== null) return;
  processInfo.child.kill("SIGTERM");
  await Promise.race([
    new Promise((resolve) => processInfo.child.once("exit", resolve)),
    new Promise((resolve) => setTimeout(resolve, 5_000)),
  ]);
  if (processInfo.child.exitCode === null) processInfo.child.kill("SIGKILL");
}

async function screenshot(page, name) {
  await page.screenshot({ path: join(screenshotsDirectory, `${name}.png`), fullPage: true });
}

async function resourceAnimationSampleDelay() {
  const resourcePack = JSON.parse(await readFile(resourcePackPath, "utf8"));
  assert.ok(Array.isArray(resourcePack.animations) && resourcePack.animations.length > 0, "Client resources expose no animation to sample");
  const frameDurations = resourcePack.animations.map((animation) => animation.frameDurationMs);
  for (const duration of frameDurations) {
    assert.ok(Number.isSafeInteger(duration) && duration > 0, "Client resource animation has an invalid frame duration");
  }
  return Math.max(...frameDurations) + 80;
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
        edgeDelta += (Math.abs(red - data[offset - 3]) + Math.abs(green - data[offset - 2]) + Math.abs(blue - data[offset - 1])) / 3;
        edgeCount += 1;
      }
    }
  }
  const pixels = info.width * info.height;
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
    meanEdgeDelta: edgeDelta / edgeCount,
  };
}

async function assertVoxelSample(canvas, path, label) {
  const metrics = await voxelSceneMetrics(await canvas.screenshot({ path }));
  const evidence = `${JSON.stringify(metrics)}; screenshot: ${path}`;
  assert.ok(metrics.nearBlackRatio < 0.85, `${label} foreground is predominantly black: ${evidence}`);
  assert.ok(metrics.medianLuminance >= 24, `${label} foreground is too dark: ${evidence}`);
  assert.ok(metrics.colorfulPixelRatio >= 0.1, `${label} foreground lost its color channels: ${evidence}`);
  assert.ok(metrics.meanEdgeDelta >= 1, `${label} foreground lost visible texture edges: ${evidence}`);
}

async function assertVoxelSceneVisible(page, name) {
  const canvas = page.locator("[data-voxel-canvas]");
  await canvas.waitFor();
  await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))));
  await assertVoxelSample(canvas, join(screenshotsDirectory, `${name}-canvas.png`), "Initial voxel sample");
  await page.waitForTimeout(await resourceAnimationSampleDelay());
  await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))));
  await assertVoxelSample(canvas, join(screenshotsDirectory, `${name}-canvas-animated.png`), "Animated voxel sample");
}

async function restoreVoxelContext(page, name) {
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
  await assertVoxelSample(
    page.locator("[data-voxel-canvas]"),
    join(screenshotsDirectory, `${name}-canvas-restored.png`),
    "Restored voxel sample",
  );
}

async function waitForRenderStatus(page, text, timeout) {
  const status = page.locator("[data-render-status]");
  try {
    await status.filter({hasText: text}).waitFor({timeout});
  } catch (error) {
    const [statusText, failures] = await Promise.all([
      status.allTextContents(),
      page.locator("[data-error]").allTextContents(),
    ]);
    throw new Error(`Timed out waiting for render status ${JSON.stringify(text)}; current=${JSON.stringify(statusText)} errors=${JSON.stringify(failures)}`, {cause: error});
  }
}

async function createWorld(page, world, {waitForRendering = true} = {}) {
  await page.locator('[data-screen="create-world"]').waitFor();
  await page.locator('[data-world-name-input]').fill(world.name);
  await page.locator(`[data-preset="${world.preset}"]`).click();
  await page.locator(`[data-mode="${world.mode.toLowerCase()}"]`).click();
  await page.locator('[data-seed-input]').fill(world.seed);
  await page.locator('[data-advanced-settings]').click();
  await page.locator('[data-world-id-input]').fill(world.id);
  await page.locator('[data-create-world]').click();
  await page.waitForURL((url) => url.pathname === `/world/${world.id}`);
  await page.locator('[data-world-ready="true"]').waitFor({ timeout: 60_000 });
  assert.equal(await page.locator('[data-error]').count(), 0);
  if (!waitForRendering) return;
  const building = page.locator('[data-render-status]').filter({ hasText: "Building" });
  const ready = page.locator('[data-render-status]').filter({ hasText: "World ready" });
  await Promise.race([
    building.waitFor({timeout: 60_000}),
    ready.waitFor({timeout: 60_000}),
  ]);
  await waitForRenderStatus(page, "World ready", 120_000);
  assert.equal(await page.locator('[data-error]').count(), 0);
}

async function moveAcrossChunkBoundary(page) {
  await page.locator('[data-voxel-canvas]').click({position: {x: 320, y: 240}});
  const building = page.locator('[data-render-status]').filter({ hasText: "Building" }).waitFor({ timeout: 60_000 });
  await page.keyboard.down("Shift");
  await page.keyboard.down("w");
  await page.waitForTimeout(1_200);
  await page.keyboard.up("w");
  await page.keyboard.up("Shift");
  await building;
  await page.locator('[data-render-status]').filter({ hasText: "World ready" }).waitFor({ timeout: 120_000 });
  assert.equal(await page.locator('[data-error]').count(), 0);
}

let browser = null;
try {
  await mkdir(screenshotsDirectory, { recursive: true });
  await requireSuccess(start("Web build", ["build", "apps/web"]));

  const previewPort = await availablePort();
  const previewUrl = `http://127.0.0.1:${previewPort}/`;
  const preview = start("Web preview", ["preview", "apps/web", "--port", `${previewPort}`]);
  await waitForUrl(previewUrl, preview);

  browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({ viewport: { width: 1536, height: 1024 }, deviceScaleFactor: 1 });
  const page = await context.newPage();
  const browserFailures = [];
  page.on("pageerror", (error) => browserFailures.push(`pageerror: ${error.message}`));
  page.on("console", (message) => {
    if (message.type() === "error") browserFailures.push(`console: ${message.text()}`);
  });

  await page.goto(previewUrl, { waitUntil: "networkidle" });
  await page.locator('[data-empty-worlds]').waitFor();
  assert.equal(await page.locator('[data-play-world]').count(), 0);
  await screenshot(page, "01-empty");

  await page.locator('[data-create-first-world]').click();
  await screenshot(page, "02-create");

  const suffix = Date.now();
  const coast = {
    id: `coastal-sandbox-${suffix}`,
    name: "Coastal Sandbox",
    preset: "coast",
    mode: "Creative",
    seed: "ui-coast-visual-v1",
  };
  await createWorld(page, coast);
  await assertVoxelSceneVisible(page, "03-world");
  await restoreVoxelContext(page, "03-world");
  await moveAcrossChunkBoundary(page);
  await screenshot(page, "03-world");
  await page.locator('[data-leave-world]').click();
  await page.locator('[data-selected-world-name]').filter({ hasText: coast.name }).waitFor();
  await screenshot(page, "04-populated");

  await page.locator('[data-new-world]').click();
  const highlands = {
    id: `highland-realm-${suffix}`,
    name: "Highland Realm",
    preset: "highlands",
    mode: "Survival",
    seed: "high-clouds",
  };
  // The second world exercises persistence, carousel selection, and cancellation
  // during background Chunk streaming. The first world already owns the complete
  // renderer, animation, movement, and context-restoration acceptance path.
  await createWorld(page, highlands, {waitForRendering: false});
  await page.locator('[data-leave-world]').click();
  await page.locator('[data-selected-world-name]').filter({ hasText: highlands.name }).waitFor();
  assert.equal(await page.locator('[data-carousel-dot]').count(), 2);

  await page.locator(`[data-carousel-dot="${coast.id}"]`).hover();
  await page.locator('[data-selected-world-name]').filter({ hasText: coast.name }).waitFor();
  await page.mouse.wheel(0, 180);
  await page.locator('[data-selected-world-name]').filter({ hasText: highlands.name }).waitFor();

  assert.deepEqual(browserFailures, []);
  console.log(`Web UI acceptance passed; screenshots: ${screenshotsDirectory}`);
} finally {
  if (browser !== null) await browser.close();
  for (const processInfo of processes.reverse()) await stop(processInfo);
}
