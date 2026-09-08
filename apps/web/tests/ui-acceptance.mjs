import assert from "node:assert/strict";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { dirname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { gzipSync } from "node:zlib";
import { spawn } from "node:child_process";
import { chromium } from "playwright";
import sharp from "sharp";

const projectRoot = fileURLToPath(new URL("../../../", import.meta.url));
const velarCli = join(projectRoot, "node_modules", "@velarscript", "cli", "dist", "cli.js");
const screenshotsDirectory = join(projectRoot, "apps", "web", "generated", "ui-acceptance");
const webDistDirectory = join(projectRoot, "apps", "web", "dist");
const builtHtmlPath = join(projectRoot, "apps", "web", "dist", "index.html");
const builtManifestPath = join(webDistDirectory, "velar-build.json");
const processes = [];
const buildTimeoutMs = 120_000;
const previewReadyTimeoutMs = 30_000;
const fetchTimeoutMs = 2_000;
const browserCloseTimeoutMs = 15_000;
const gracefulStopTimeoutMs = 5_000;
const forcedStopTimeoutMs = 5_000;
const serverCloseTimeoutMs = 5_000;
const noFailure = Symbol("no failure");
const initialJavaScriptBudget = {raw: 1024 * 1024, gzip: 230 * 1024};
const secondaryRouteJavaScriptBudget = {raw: 900 * 1024, gzip: 200 * 1024};
const worldJavaScriptBudget = {raw: 5 * 1024 * 1024, gzip: 1330 * 1024};

function staticImportSpecifiers(source, owner) {
  const specifiers = [];
  let cursor = 0;
  while (cursor < source.length) {
    while (/\s/u.test(source[cursor] ?? "")) cursor += 1;
    if (!source.startsWith("import", cursor)) break;
    const afterKeyword = cursor + "import".length;
    if (/[A-Za-z0-9_$]/u.test(source[afterKeyword] ?? "")) break;
    let expressionStart = afterKeyword;
    while (/\s/u.test(source[expressionStart] ?? "")) expressionStart += 1;
    if (source[expressionStart] === "(") break;
    const statementEnd = source.indexOf(";", expressionStart);
    assert.notEqual(statementEnd, -1, `${owner} contains an unterminated static import`);
    const statement = source.slice(cursor, statementEnd);
    const quoted = [...statement.matchAll(/["']([^"']+)["']/gu)];
    assert.ok(quoted.length > 0, `${owner} contains a static import with no module specifier`);
    specifiers.push(quoted.at(-1)[1]);
    cursor = statementEnd + 1;
  }
  return specifiers;
}

async function staticJavaScriptClosure(entryPath) {
  const pending = [resolve(webDistDirectory, entryPath)];
  const visited = new Set();
  while (pending.length > 0) {
    const current = pending.pop();
    if (visited.has(current)) continue;
    visited.add(current);
    const projectPath = relative(webDistDirectory, current);
    assert.ok(projectPath !== ".." && !projectPath.startsWith(`..${sep}`), `${entryPath} imports outside the Web build`);
    assert.ok(current.endsWith(".js"), `${entryPath} statically imports a non-JavaScript module: ${projectPath}`);
    const source = await readFile(current, "utf8");
    for (const specifier of staticImportSpecifiers(source, projectPath)) {
      assert.ok(specifier.startsWith("./"), `${projectPath} retains an external production import: ${specifier}`);
      pending.push(resolve(dirname(current), specifier));
    }
  }
  return visited;
}

async function assertJavaScriptPerformance(label, paths, budget) {
  let rawBytes = 0;
  let gzipBytes = 0;
  for (const path of paths) {
    const bytes = await readFile(path);
    rawBytes += bytes.byteLength;
    gzipBytes += gzipSync(bytes, {level: 9}).byteLength;
  }
  assert.ok(rawBytes <= budget.raw, `${label} JavaScript closure exceeds its raw budget: ${rawBytes} > ${budget.raw}`);
  assert.ok(gzipBytes <= budget.gzip, `${label} JavaScript closure exceeds its gzip budget: ${gzipBytes} > ${budget.gzip}`);
}

function requireRouteAsset(manifest, routeName) {
  const pattern = new RegExp(`^assets/chunk-${routeName}-[A-Z0-9]+\\.js$`, "u");
  const assets = manifest.assets.filter((asset) => asset.role === "asset" && pattern.test(asset.path));
  assert.equal(assets.length, 1, `${routeName} must remain one lazy production entry chunk`);
  return assets[0].path;
}

async function assertBuildPerformance() {
  const manifest = JSON.parse(await readFile(builtManifestPath, "utf8"));
  assert.match(manifest.entry, /^assets\/main-[A-Z0-9]+\.js$/u, "Web build has no content-hashed application entry");
  const initial = await staticJavaScriptClosure(manifest.entry);
  await assertJavaScriptPerformance("Initial", initial, initialJavaScriptBudget);
  for (const [label, routeName, budget] of [
    ["Create world", "create-world-page", secondaryRouteJavaScriptBudget],
    ["Open world", "open-world-page", secondaryRouteJavaScriptBudget],
    ["World", "world-page", worldJavaScriptBudget],
  ]) {
    const route = await staticJavaScriptClosure(requireRouteAsset(manifest, routeName));
    for (const initialPath of initial) route.delete(initialPath);
    await assertJavaScriptPerformance(label, route, budget);
  }
}

function errorText(error) {
  return error instanceof Error ? `${error.name}: ${error.message}` : String(error);
}

async function graphicsBackend(browser) {
  const session = await browser.newBrowserCDPSession();
  try {
    const {gpu} = await session.send("SystemInfo.getInfo");
    const device = gpu.devices[0] ?? {};
    const renderer = device.deviceString ?? gpu.auxAttributes?.glRenderer ?? "unknown";
    const software = /swiftshader|llvmpipe|software rasterizer/iu.test(renderer)
      || gpu.featureStatus?.webgl === "unavailable_software";
    return {
      renderer,
      vendor: device.vendorString ?? "unknown",
      accelerated: !software,
    };
  } finally {
    await session.detach();
  }
}

async function boundedOperation(label, timeoutMs, operation) {
  let timer = null;
  const timeout = new Promise((_resolve, reject) => {
    timer = setTimeout(() => reject(new Error(`${label} did not finish within ${timeoutMs} milliseconds`)), timeoutMs);
  });
  try {
    return await Promise.race([Promise.resolve().then(operation), timeout]);
  } finally {
    if (timer !== null) clearTimeout(timer);
  }
}

async function attemptCleanup(failures, label, operation) {
  try {
    await operation();
  } catch (error) {
    failures.push(new Error(`${label}: ${errorText(error)}`, {cause: error}));
  }
}

function reportCleanupFailures(scope, failures) {
  if (failures.length === 0) return;
  process.stderr.write(`${scope} also encountered cleanup failures:\n${failures.map((error) => `- ${error.message}`).join("\n")}\n`);
}

async function closeNetServer(server, label) {
  if (!server.listening) return;
  await boundedOperation(label, serverCloseTimeoutMs, () => new Promise((resolve, reject) => {
    server.close((error) => error === undefined ? resolve() : reject(error));
  }));
}

async function portIsAvailable(port) {
  const server = createServer();
  let listening = false;
  try {
    listening = await boundedOperation(`Preview port ${port} probe`, serverCloseTimeoutMs, () => new Promise((resolve, reject) => {
      const onError = (error) => {
        server.off("listening", onListening);
        if (error?.code === "EADDRINUSE") resolve(false);
        else reject(error);
      };
      const onListening = () => {
        server.off("error", onError);
        resolve(true);
      };
      server.once("error", onError);
      server.once("listening", onListening);
      server.listen(port, "127.0.0.1");
    }));
    return listening;
  } finally {
    if (listening) await closeNetServer(server, `Preview port ${port} probe close`);
  }
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
  const processInfo = { name, child, output, processError: null, closed: false, completion: null };
  processInfo.completion = new Promise((resolve) => {
    child.once("error", (error) => {
      processInfo.processError = error;
    });
    child.once("close", (code, signal) => {
      processInfo.closed = true;
      resolve({code, signal});
    });
  });
  processes.push(processInfo);
  return processInfo;
}

function processFailure(processInfo) {
  const status = processInfo.processError !== null
    ? `encountered a process error: ${errorText(processInfo.processError)}`
    : processInfo.child.signalCode !== null
      ? `exited after signal ${processInfo.child.signalCode}`
      : `exited with code ${processInfo.child.exitCode}`;
  return `${processInfo.name} ${status}:\n${processInfo.output.join("")}`;
}

function processHasExited(processInfo) {
  return processInfo.closed
    || processInfo.child.exitCode !== null
    || processInfo.child.signalCode !== null;
}

async function requireSuccess(processInfo, timeoutMs) {
  let result;
  try {
    result = await boundedOperation(processInfo.name, timeoutMs, () => processInfo.completion);
  } catch (error) {
    throw new Error(`${errorText(error)}\n${processInfo.output.join("")}`, {cause: error});
  }
  if (processInfo.processError !== null || result.signal !== null || result.code !== 0) {
    throw new Error(processFailure(processInfo));
  }
}

async function fetchPage(url, timeoutMs) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(new Error(`Fetch ${url} timed out`)), timeoutMs);
  try {
    const response = await fetch(url, {
      headers: {accept: "text/html"},
      signal: controller.signal,
    });
    return {response, text: await response.text()};
  } finally {
    clearTimeout(timer);
  }
}

async function waitForUrl(url, processInfo, expectedHtml) {
  const deadline = Date.now() + previewReadyTimeoutMs;
  let lastFailure = null;
  while (Date.now() < deadline) {
    if (processHasExited(processInfo)) throw new Error(processFailure(processInfo));
    let page;
    try {
      page = await fetchPage(url, Math.min(fetchTimeoutMs, deadline - Date.now()));
    } catch (error) {
      lastFailure = error;
      await new Promise((resolve) => setTimeout(resolve, 100));
      continue;
    }
    if (!page.response.ok) {
      lastFailure = new Error(`Preview returned HTTP ${page.response.status}`);
      await new Promise((resolve) => setTimeout(resolve, 100));
      continue;
    }
    assert.match(page.response.headers.get("content-type") ?? "", /^text\/html(?:;|$)/iu, "Preview root is not HTML");
    assert.equal(page.text, expectedHtml, "Preview root does not match this run's OpenVoxel build");
    const previewAnnouncement = `VelarScript production preview: ${url}`;
    if (processInfo.output.join("").includes(previewAnnouncement)) return;
    lastFailure = new Error(`Preview child has not announced ownership of ${url}`);
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`${processInfo.name} did not become ready at ${url}${lastFailure === null ? "" : `: ${errorText(lastFailure)}`}`);
}

async function stop(processInfo) {
  if (processInfo.closed) return;
  if (processHasExited(processInfo)) {
    await boundedOperation(`${processInfo.name} close after exit`, forcedStopTimeoutMs, () => processInfo.completion);
    return;
  }
  processInfo.child.kill("SIGTERM");
  try {
    await boundedOperation(`${processInfo.name} graceful shutdown`, gracefulStopTimeoutMs, () => processInfo.completion);
    return;
  } catch (gracefulError) {
    if (processHasExited(processInfo)) {
      await boundedOperation(`${processInfo.name} close after graceful exit`, forcedStopTimeoutMs, () => processInfo.completion);
      return;
    }
    processInfo.child.kill("SIGKILL");
    try {
      await boundedOperation(`${processInfo.name} forced shutdown`, forcedStopTimeoutMs, () => processInfo.completion);
    } catch (forcedError) {
      throw new AggregateError([gracefulError, forcedError], `${processInfo.name} did not exit after SIGTERM and SIGKILL`);
    }
  }
}

async function screenshot(page, name) {
  await page.screenshot({ path: join(screenshotsDirectory, `${name}.png`), fullPage: true });
}

async function dispatchCarouselWheel(page, init) {
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
    visibleEdgeRatio: visibleEdges / edgeCount,
  };
}

async function assertVoxelSample(canvas, path, label) {
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
  assert.ok(metrics.colorfulPixelRatio >= minimumColorfulPixelRatio, `${label} foreground lost its color channels: ${evidence}`);
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

async function assertRenderedGeometry(page) {
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

async function assertStreamingWorkBounded(page, label) {
  const metrics = await streamingWorkMetrics(page);
  const evidence = `${label}: ${JSON.stringify(metrics)}`;
  // A directional cone contains at most one of each antipodal pair outside
  // its all-direction safety sphere: acquisition <= 33 + (515 - 33) / 2,
  // retention <= 123 + (925 - 123) / 2. Add one four-section commit surplus.
  // These bounds cover every camera pitch/yaw, not just the axis-aligned view.
  assert.ok(metrics.residentChunks <= 528, `Resident Chunk window grew without bound; ${evidence}`);
  assert.ok(metrics.terrainPendingChunks <= 274, `Terrain request queue grew without bound; ${evidence}`);
  assert.ok(metrics.meshQueuedChunks <= metrics.residentChunks, `Mesh queue contains non-resident Chunks; ${evidence}`);
  assert.ok(metrics.meshActiveChunks <= 2, `Meshing exceeded its Worker budget; ${evidence}`);
  assert.ok(metrics.uploadQueuedChunks <= 2, `GPU upload queue exceeded its producer budget; ${evidence}`);
  assert.ok(metrics.pending <= 804, `Combined streaming work grew without bound; ${evidence}`);
  return metrics;
}

async function assertVoxelSceneVisible(page, name, browserFailures) {
  const canvas = page.locator("[data-voxel-canvas]");
  await canvas.waitFor();
  await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))));
  assert.deepEqual(browserFailures, [], "Browser failed before the first rendered world frame");
  await assertVoxelSample(canvas, join(screenshotsDirectory, `${name}-canvas.png`), "Initial voxel sample");
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
  await waitForVoxelSample(
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

async function waitForWorkerCount(page, expected, label) {
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

async function createWorld(page, world, {waitForRendering = true} = {}) {
  await fillWorldCreation(page, world);
  await page.locator('[data-create-world]').click();
  await page.waitForURL((url) => url.pathname === `/world/${encodeURIComponent(world.id)}`);
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
  await assertRenderedGeometry(page);
}

async function cancelCreateWhilePending(page, world, browserFailures) {
  await fillWorldCreation(page, world);
  const workerCount = page.workers().length;
  const heldWorker = await holdNextWorkerScript(page, "local-worker.js");
  try {
    await page.locator('[data-create-world]').click();
    await heldWorker.waitUntilRequested();
    await page.locator('[data-back-home]').click();
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

async function cancelOpenWhilePending(page, worldId, browserFailures) {
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

async function cancelWorldEntryWhileLoading(page, world, browserFailures) {
  const workerCount = page.workers().length;
  const heldWorker = await holdNextWorkerScript(page, "meshing-worker.js");
  try {
    await page.locator('[data-play-world]').click();
    await page.waitForURL((url) => url.pathname === `/world/${encodeURIComponent(world.id)}`);
    await page.locator('[data-world-loading]').waitFor();
    await heldWorker.waitUntilRequested();
    await page.locator('[data-leave-world]').click();
    await page.locator('[data-selected-world-name]').filter({hasText: world.name}).waitFor();
  } finally {
    await heldWorker.release();
  }
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

async function moveFirstPersonWorld(page, graphics) {
  const canvas = page.locator('[data-voxel-canvas]');
  assert.equal(await canvas.getAttribute("data-navigation-mode"), "first-person");
  assert.equal(await canvas.getAttribute("data-movement-mode"), "creative-flight");
  assert.equal(await page.locator('[data-first-person-controls]').count(), 1);
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

  await page.keyboard.press("Escape");
  await page.locator('[data-voxel-canvas][data-pointer-locked="false"]').waitFor({timeout: 10_000});
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

async function assertWorldHasSurvivalWalk(page) {
  const canvas = page.locator('[data-voxel-canvas]');
  await page.locator('[data-world-ready="true"]').waitFor({timeout: 120_000});
  await waitForRenderStatus(page, "World ready", 120_000);
  assert.equal(await canvas.getAttribute("data-navigation-mode"), "first-person");
  assert.equal(await canvas.getAttribute("data-movement-mode"), "survival-walk");
  assert.equal(await page.locator('[data-first-person-controls]').count(), 1);
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
  assert.deepEqual(await page.locator('[data-error]').allTextContents(), []);
}

let browser = null;
let mainFailure = noFailure;
const cleanupFailures = [];
try {
  await rm(screenshotsDirectory, { recursive: true, force: true });
  await mkdir(screenshotsDirectory, { recursive: true });
  await requireSuccess(start("Web build", ["build", "apps/web"]), buildTimeoutMs);
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
  };
  await createWorld(page, coast);
  assert.equal(await page.evaluate(() => performance.getEntriesByType("resource")
    .some((entry) => entry.name.includes("/assets/chunk-world-page-"))), true,
  "Entering a world did not load the lazy world route");
  await assertVoxelSceneVisible(page, "03-world", browserFailures);
  // Measure ordinary exploration before deliberately destroying the graphics
  // context; recovery is then checked against the fully populated destination.
  await moveFirstPersonWorld(page, graphics);
  await assertVoxelSample(
    page.locator("[data-voxel-canvas]"),
    join(screenshotsDirectory, "03-world-canvas-moved.png"),
    "Moved voxel sample",
  );
  await restoreVoxelContext(page, "03-world");
  await screenshot(page, "03-world");
  await page.locator('[data-leave-world]').click();
  await page.locator('[data-selected-world-name]').filter({ hasText: coast.name }).waitFor();
  assert.equal(await dispatchCarouselWheel(page, {deltaY: 180}), false, "Single-world carousel consumed page scrolling");
  await screenshot(page, "04-populated");
  await cancelWorldEntryWhileLoading(page, coast, browserFailures);

  await page.goto(new URL(`/world/${encodeURIComponent(coast.id)}`, previewUrl).href, {waitUntil: "networkidle"});
  await page.locator('[data-world-ready="true"]').waitFor({timeout: 60_000});
  assert.equal(await page.locator('[data-voxel-canvas]').getAttribute("data-navigation-mode"), "first-person");
  assert.equal(await page.locator('[data-first-person-controls]').count(), 1);
  await page.locator('[data-leave-world]').click();
  await page.locator('[data-selected-world-name]').filter({hasText: coast.name}).waitFor();

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
  await page.locator('[data-leave-world]').click();
  await page.locator('[data-selected-world-name]').filter({ hasText: highlands.name }).waitFor();
  assert.equal(await page.locator('[data-carousel-dot]').count(), 2);

  await page.locator(`[data-carousel-dot="${coast.id}"]`).hover();
  await page.locator('[data-selected-world-name]').filter({ hasText: coast.name }).waitFor();
  assert.equal(await dispatchCarouselWheel(page, {ctrlKey: true, deltaY: 180}), false, "Carousel consumed a Ctrl-wheel zoom gesture");
  assert.equal(await dispatchCarouselWheel(page, {deltaY: 180, metaKey: true}), false, "Carousel consumed a Meta-wheel zoom gesture");
  assert.equal(await dispatchCarouselWheel(page, {deltaY: 0}), false, "Carousel consumed an inert wheel event");
  await page.locator('[data-selected-world-name]').filter({ hasText: coast.name }).waitFor();
  assert.equal(await dispatchCarouselWheel(page, {deltaY: 180}), true, "Carousel did not consume a world-changing wheel gesture");
  await page.locator('[data-selected-world-name]').filter({ hasText: highlands.name }).waitFor();
  assert.equal(await dispatchCarouselWheel(page, {deltaY: 180}), false, "Carousel consumed a throttled wheel event");
  await page.locator('[data-selected-world-name]').filter({ hasText: highlands.name }).waitFor();

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
