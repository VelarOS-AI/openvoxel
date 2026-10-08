import assert from "node:assert/strict";
import {mkdir, readFile, writeFile} from "node:fs/promises";
import {join} from "node:path";
import {chromium} from "playwright";
import {builtHtmlPath, projectRoot} from "./support/ui-acceptance-paths.mjs";
import {availablePort, graphicsBackend, processes, start, stop, waitForUrl} from "./support/ui-acceptance-runtime.mjs";
import {createWorld} from "./support/ui-acceptance-world.mjs";
import {instrumentWebGPU} from "./support/webgpu-performance.mjs";
import {rendererDiagnosticModules, enableDiagnosticTimestamps, instrumentRenderer, instrumentFrameCadence} from "./support/renderer-performance.mjs";

// Run through tools/run-validation.mjs against a build, or the existing dev
// server with --dev. Fresh stores and fixed routes keep each variant repeatable.
const label = process.argv[2] ?? "after";
const retina = process.argv.includes("--retina");
const development = process.argv.includes("--dev");
const sustained = process.argv.includes("--sustained");
const turns = process.argv.includes("--turns");
const rotate = process.argv.includes("--rotate");
const strafe = process.argv.includes("--strafe");
const steady = process.argv.includes("--steady");
const uncapped = process.argv.includes("--uncapped");
const cpuOnly = process.argv.includes("--cpu-only");
const renderProfile = process.argv.includes("--render-profile") || cpuOnly;
const scaleOption = process.argv.find(value => value.startsWith("--scale="));
const renderScale = scaleOption ? Number(scaleOption.split("=")[1]) : retina ? 1 : .85;
assert.ok(renderScale >= .5 && renderScale <= 1);
assert.ok(!renderProfile || !development, "Renderer diagnostics require production source maps");
assert.ok(!(rotate && strafe), "rotation and strafe are distinct routes");
assert.ok(!rotate || turns, "rotation probe requires --turns");
const vegetated = process.argv.includes("--vegetated");
const backend = process.argv.find(value => value.startsWith("--backend="))?.split("=")[1] ?? "auto";
assert.ok(["auto", "webgl", "webgpu"].includes(backend), "backend must be auto, webgl or webgpu");
assert.ok(!vegetated || turns, "vegetated flight requires --turns for pointer-controlled aerial viewing");
assert.match(label, /^[a-z0-9-]+$/u);
const evidence = join(projectRoot, "apps/web/generated/streaming-performance", label);
await mkdir(evidence, {recursive: true});
let browser;
let page;
let traceSession;
let heapSession;
const seed = vegetated ? "climate-extremes" : retina ? "block-ui" : "continental-ridges";
const report = {label, development, sustained, turns, rotate, strafe, steady, uncapped, seed, viewDistance: 8, samples: [], errors: []};
try {
  const port = development ? 7173 : await availablePort();
  const url = `http://127.0.0.1:${port}/`;
  if (!development) {
    const preview = start("Streaming preview", ["preview", "apps/web", "--port", String(port)]);
    await waitForUrl(url, preview, await readFile(builtHtmlPath, "utf8"));
  }
  browser = await chromium.launch({headless: true, args: ["--use-angle=metal", "--enable-unsafe-webgpu", ...(uncapped ? ["--disable-frame-rate-limit", "--disable-gpu-vsync"] : [])]});
  report.graphics = await graphicsBackend(browser);
  report.browser = browser.version();
  report.display = {width: 1440, height: 900, deviceScaleFactor: retina ? 2 : 1, renderScale, bloom: retina};
  page = await browser.newPage({viewport: {width: 1440, height: 900}, deviceScaleFactor: retina ? 2 : 1});
  if (process.argv.includes("--gpu-profile")) await page.addInitScript(instrumentWebGPU);
  if (renderProfile && !cpuOnly) await page.addInitScript(enableDiagnosticTimestamps);
  page.on("pageerror", error => report.errors.push(error.message));
  page.on("console", message => {
    if (message.type() === "warning") console.warn(message.text().slice(0, 2000));
    if (message.type() === "error" || /WebGPU uncaptured error/u.test(message.text())) {
      report.errors.push(message.text());
      console.error(message.text().slice(0, 1500));
    }
  });
  await page.addInitScript(({retina, backend, renderScale}) => localStorage.setItem("openvoxel.settings.v1", JSON.stringify({
    renderBackend: backend, viewDistance: 8, renderScale, timeMode: "fixed", hour: 12, weather: "clear", bloom: retina,
  })), {retina, backend, renderScale});
  if (turns) await page.addInitScript(() => {
    let locked = null;
    Object.defineProperty(document, "pointerLockElement", {configurable: true, get: () => locked});
    Object.defineProperty(HTMLCanvasElement.prototype, "requestPointerLock", {configurable: true, value() {
      locked = this;
      document.dispatchEvent(new Event("pointerlockchange"));
      return Promise.resolve();
    }});
    Object.defineProperty(document, "exitPointerLock", {configurable: true, value() {
      locked = null;
      document.dispatchEvent(new Event("pointerlockchange"));
    }});
  });
  await page.goto(url);
  await page.locator("[data-create-first-world]").click();
  const profiler = process.argv.includes("--profile") ? await page.context().newCDPSession(page) : null;
  if (profiler) {
    await profiler.send("Profiler.enable");
    await profiler.send("Profiler.start");
  }
  const started = Date.now();
  await Promise.race([createWorld(page, {
    id: "streaming-probe", name: "8 区块流送验证", seed, mode: "Creative", preset: "meadow",
  }), page.locator("[data-error]").waitFor({state: "visible", timeout: 120_000}).then(async () => {
    throw new Error(await page.locator("[data-error]").innerText());
  })]);
  report.readyMs = Date.now() - started;
  report.backend = await page.locator('[data-app][data-screen="world"]').getAttribute("data-render-backend");
  if (backend === "webgpu") assert.equal(report.backend, "WebGPU");
  if (backend === "webgl" || backend === "auto") assert.equal(report.backend, "WebGL 2");
  if (!development) {
    const modules = await rendererDiagnosticModules(join(projectRoot, "apps/web/dist/assets"));
    await page.evaluate(instrumentFrameCadence, modules);
    if (renderProfile) await page.evaluate(instrumentRenderer, {...modules, cpuOnly, uniformChanges: process.argv.includes("--uniform-profile")});
  }

  async function sample(phase) {
    const data = await page.locator('[data-app][data-screen="world"]').evaluate(element => Object.fromEntries(
      [...element.attributes]
        .filter(attribute => /data-(render|resident|terrain|mesh|upload|view-chunk)/u.test(attribute.name))
        .map(attribute => [attribute.name, attribute.value]),
    ));
    report.samples.push({phase, elapsedMs: Date.now() - started, ...data});
    console.log(phase, report.samples.at(-1));
    return ["terrain-pending", "mesh-active", "mesh-queued", "upload-queued"]
      .reduce((sum, key) => sum + Number(data[`data-${key}-chunks`]), 0);
  }

  async function settle(phase) {
    const deadline = Date.now() + 60_000;
    let pending = Infinity;
    do {
      await page.waitForTimeout(2_000);
      pending = await sample(phase);
    } while (pending > 0 && Date.now() < deadline);
    assert.equal(pending, 0, `${phase} did not settle within 60 seconds`);
    return {pending, elapsedMs: Date.now() - started};
  }

  report.initial = await settle("initial");
  const workerProfiles = [];
  let workerSession;
  if (process.argv.includes("--workers")) {
    workerSession = await browser.newBrowserCDPSession();
    const pending = new Map();
    let messageId = 0;
    workerSession.on("Target.receivedMessageFromTarget", ({sessionId, message}) => {
      const response = JSON.parse(message), key = `${sessionId}:${response.id}`;
      const waiter = pending.get(key);
      if (waiter) { pending.delete(key); response.error ? waiter.reject(response.error) : waiter.resolve(response.result); }
    });
    async function command(sessionId, method) {
      const id = ++messageId;
      const response = new Promise((resolve, reject) => pending.set(`${sessionId}:${id}`, {resolve, reject}));
      await workerSession.send("Target.sendMessageToTarget", {sessionId, message: JSON.stringify({id, method})});
      return response;
    }
    const {targetInfos} = await workerSession.send("Target.getTargets");
    for (const target of targetInfos.filter(target => target.type === "worker")) {
      const {sessionId} = await workerSession.send("Target.attachToTarget", {targetId: target.targetId});
      await command(sessionId, "Profiler.enable");
      await command(sessionId, "Profiler.start");
      workerProfiles.push({url: target.url, stop: () => command(sessionId, "Profiler.stop")});
    }
  }
  if (profiler) {
    const {profile} = await profiler.send("Profiler.stop");
    await writeFile(join(evidence, "main.cpuprofile"), JSON.stringify(profile));
    await profiler.send("Profiler.start");
  }
  const initialPosition = report.samples.at(-1);
  // Headless Chromium does not grant pointer lock on every macOS backend.
  // Exercise the production focused-canvas keyboard path for repeatable flight.
  const canvas = page.locator("[data-voxel-canvas]");
  if (!turns) await canvas.evaluate(element => Object.defineProperty(element, "requestPointerLock", {value: undefined}));
  await canvas.click({position: {x: 500, y: 360}});
  report.input = turns ? "pointer-lock-shim" : "focused-canvas";
  if (vegetated) {
    await page.keyboard.down("Space");
    await page.waitForTimeout(4_000);
    await page.keyboard.up("Space");
    await page.evaluate(() => document.dispatchEvent(new MouseEvent("mousemove", {movementX: 0, movementY: 240, bubbles: true})));
  }
  if (steady) await settle("view-initial");
  if (process.argv.includes("--heap-profile")) {
    heapSession = await page.context().newCDPSession(page);
    // Include short-lived allocations: retained heap alone hides the churn
    // that triggers collections while new chunks arrive.
    report.heapSampling = {samplingInterval: 32768,
      includeObjectsCollectedByMajorGC: true, includeObjectsCollectedByMinorGC: true};
    await heapSession.send("HeapProfiler.startSampling", report.heapSampling);
  }
  if (process.argv.includes("--trace")) {
    traceSession = await page.context().newCDPSession(page);
    await traceSession.send("Tracing.start", {
      categories: "toplevel,blink.user_timing,devtools.timeline,v8,disabled-by-default-devtools.timeline" + (process.argv.includes("--gpu-profile") ? ",gpu,dawn,viz,disabled-by-default-gpu.dawn" : ""),
      transferMode: "ReturnAsStream",
    });
    report.traceClock = await page.evaluate(() => {
      performance.mark("openvoxel-streaming-profile-clock");
      return performance.getEntriesByName("openvoxel-streaming-profile-clock").at(-1).startTime;
    });
  }
  await page.evaluate(() => {
    globalThis.__webgpuPerformance?.reset();
    globalThis.__rendererPerformance?.reset();
    globalThis.__renderedFrameCadence?.reset();
    globalThis.frameTimes = [];
    globalThis.slowFrames = [];
    globalThis.longTasks = [];
    globalThis.longTaskObserver = new PerformanceObserver(list => {
      globalThis.longTasks.push(...list.getEntries().map(entry => ({start: entry.startTime, duration: entry.duration})));
    });
    globalThis.longTaskObserver.observe({entryTypes: ["longtask"]});
    let previous = performance.now();
    function frame(now) {
      globalThis.frameTimes.push(now - previous);
      if (now - previous > 33) globalThis.slowFrames.push({start: previous, duration: now - previous});
      previous = now;
      globalThis.frameHandle = requestAnimationFrame(frame);
    }
    globalThis.frameHandle = requestAnimationFrame(frame);
  });
  if (rotate) await page.evaluate(() => {
    globalThis.rotationProbe = setInterval(() => document.dispatchEvent(new MouseEvent("mousemove", {movementX: 20, movementY: 0, bubbles: true})), 100);
  });
  else if (!steady) await page.keyboard.down(strafe ? "d" : "w");
  for (let index = 0; index < (sustained ? 15 : 4); index += 1) {
    if (turns && !rotate && !strafe && !steady && (index === 5 || index === 10)) {
      await page.evaluate(direction => {
        for (let step = 0; step < 10; step++) document.dispatchEvent(new MouseEvent("mousemove", {movementX: 100 * direction, movementY: 0, bubbles: true}));
      }, index === 5 ? 1 : -1);
    }
    await page.waitForTimeout(2_000);
    await sample("moving");
  }
  if (rotate) await page.evaluate(() => clearInterval(globalThis.rotationProbe));
  else if (!steady) await page.keyboard.up(strafe ? "d" : "w");
  const stoppedAt = Date.now();
  const finalPosition = report.samples.at(-1);
  (rotate || steady ? assert.equal : assert.notEqual)(
    `${finalPosition["data-view-chunk-x"]}:${finalPosition["data-view-chunk-z"]}`,
    `${initialPosition["data-view-chunk-x"]}:${initialPosition["data-view-chunk-z"]}`,
    rotate ? "Rotation unexpectedly moved the camera horizontally" : "Flight input did not move the camera across a Chunk boundary",
  );
  report.move = await settle("move-settle");
  report.move.waitAfterStopMs = Date.now() - stoppedAt;
  report.frame = await page.evaluate(() => {
    cancelAnimationFrame(globalThis.frameHandle);
    globalThis.longTaskObserver.disconnect();
    const times = globalThis.frameTimes.sort((a, b) => a - b);
    return {
      count: times.length, p50: times[Math.floor(times.length * .5)],
      mean: times.reduce((sum, value) => sum + value, 0) / times.length,
      p95: times[Math.floor(times.length * .95)], over50: times.filter(value => value > 50).length,
      p99: times[Math.floor(times.length * .99)], max: times.at(-1), longTasks: globalThis.longTasks,
      slowFrames: globalThis.slowFrames,
    };
  });
  report.renderedFrame = await page.evaluate(() => globalThis.__renderedFrameCadence?.read() ?? null);
  report.webgpu = await page.evaluate(() => globalThis.__webgpuPerformance?.read() ?? null);
  report.renderer = await page.evaluate(() => globalThis.__rendererPerformance?.read() ?? null);
  if (heapSession) {
    const {profile} = await heapSession.send("HeapProfiler.stopSampling");
    await writeFile(join(evidence, "movement.heapprofile"), JSON.stringify(profile));
    await heapSession.detach();
    heapSession = null;
  }
  if (traceSession) {
    const complete = new Promise(resolve => traceSession.once("Tracing.tracingComplete", resolve));
    await traceSession.send("Tracing.end");
    const {stream} = await complete;
    const parts = [];
    for (;;) {
      const part = await traceSession.send("IO.read", {handle: stream});
      parts.push(Buffer.from(part.data, part.base64Encoded ? "base64" : "utf8"));
      if (part.eof) break;
    }
    await traceSession.send("IO.close", {handle: stream});
    await writeFile(join(evidence, "movement.trace.json"), Buffer.concat(parts));
    await traceSession.detach();
    traceSession = null;
  }
  if (profiler) {
    const {profile} = await profiler.send("Profiler.stop");
    await writeFile(join(evidence, "movement.cpuprofile"), JSON.stringify(profile));
    await profiler.detach();
  }
  for (const [index, worker] of workerProfiles.entries()) {
    const {profile} = await worker.stop();
    await writeFile(join(evidence, `worker-${index}.cpuprofile`), JSON.stringify(profile));
  }
  report.workers = workerProfiles.map(worker => worker.url);
  await workerSession?.detach();
  await page.screenshot({path: join(evidence, "world.png")});
  assert.deepEqual(report.errors, []);
} catch (error) {
  report.failure = error.message;
  if (page) {
    report.pageText = await page.locator("body").innerText().catch(() => "unavailable");
    await page.screenshot({path: join(evidence, "failure.png")}).catch(() => {});
  }
  throw error;
} finally {
  await writeFile(join(evidence, "report.json"), JSON.stringify(report, null, 2));
  await browser?.close();
  for (const child of [...processes].reverse()) await stop(child);
}
console.log(JSON.stringify({readyMs: report.readyMs, initial: report.initial, move: report.move, frame: report.frame, errors: report.errors}));
