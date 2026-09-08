import assert from "node:assert/strict";
import {createServer} from "node:http";
import {mkdtemp, mkdir, readFile, rm, writeFile} from "node:fs/promises";
import {tmpdir} from "node:os";
import {dirname, join} from "node:path";
import {fileURLToPath} from "node:url";
import {build} from "esbuild";
import {chromium} from "playwright";
import sharp from "sharp";

const renderingRoot = fileURLToPath(new URL("../", import.meta.url));
const fixtureRoot = join(renderingRoot, "tests", "support");
const evidenceRoot = join(renderingRoot, "generated", "gpu-render-probe");
const temporaryRoot = await mkdtemp(join(tmpdir(), "openvoxel-gpu-render-probe-"));
const bundlePath = join(temporaryRoot, "probe.js");
const htmlPath = join(fixtureRoot, "gpu-render-probe.html");
const entryPath = join(fixtureRoot, "gpu-render-probe.browser.mjs");
const resourcePackPath = join(renderingRoot, "generated", "client-resource-pack.json");
const bundleBuildTimeoutMs = 120_000;
const browserCloseTimeoutMs = 15_000;
const pageCleanupTimeoutMs = 10_000;
const serverCloseTimeoutMs = 5_000;
const temporaryCleanupTimeoutMs = 10_000;
const noFailure = Symbol("no failure");

function errorText(error) {
  return error instanceof Error ? `${error.name}: ${error.message}` : String(error);
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

async function listen(server) {
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  assert.ok(address !== null && typeof address === "object", "GPU probe server has no TCP address");
  return `http://127.0.0.1:${address.port}`;
}

async function closeServer(server) {
  if (!server.listening) return;
  const closing = new Promise((resolve, reject) => {
    server.close((error) => error === undefined ? resolve() : reject(error));
  });
  server.closeAllConnections();
  await closing;
}

async function decodePng(png) {
  return sharp(png).removeAlpha().raw().toBuffer({resolveWithObject: true});
}

async function imageMetrics(png) {
  const metadata = await sharp(png).metadata();
  assert.ok(metadata.width !== undefined && metadata.height !== undefined, "GPU probe screenshot has no dimensions");
  const region = {
    left: Math.floor(metadata.width * 0.25),
    top: Math.floor(metadata.height * 0.25),
    width: Math.floor(metadata.width * 0.5),
    height: Math.floor(metadata.height * 0.55),
  };
  const {data, info} = await sharp(png).extract(region).removeAlpha().raw().toBuffer({resolveWithObject: true});
  let nearBlack = 0;
  let lowLight = 0;
  let nearWhite = 0;
  let luminance = 0;
  let colorful = 0;
  let edgeDelta = 0;
  let edgeCount = 0;
  const colors = new Set();
  for (let y = 0; y < info.height; y += 1) {
    for (let x = 0; x < info.width; x += 1) {
      const offset = (y * info.width + x) * 3;
      const red = data[offset];
      const green = data[offset + 1];
      const blue = data[offset + 2];
      if (red <= 5 && green <= 5 && blue <= 5) nearBlack += 1;
      if ((red + green + blue) / 3 <= 20) lowLight += 1;
      if (red >= 235 && green >= 235 && blue >= 235) nearWhite += 1;
      luminance += red * 0.2126 + green * 0.7152 + blue * 0.0722;
      if (Math.max(red, green, blue) - Math.min(red, green, blue) >= 14) colorful += 1;
      colors.add(`${red >> 4}:${green >> 4}:${blue >> 4}`);
      if (x > 0) {
        edgeDelta += (Math.abs(red - data[offset - 3]) + Math.abs(green - data[offset - 2]) + Math.abs(blue - data[offset - 1])) / 3;
        edgeCount += 1;
      }
    }
  }
  const sampledPixels = info.width * info.height;
  return {
    nearBlackRatio: nearBlack / sampledPixels,
    lowLightRatio: lowLight / sampledPixels,
    nearWhiteRatio: nearWhite / sampledPixels,
    meanLuminance: luminance / sampledPixels,
    colorfulRatio: colorful / sampledPixels,
    quantizedColors: colors.size,
    meanHorizontalEdgeDelta: edgeDelta / edgeCount,
  };
}

async function changedPixelRatio(first, second, minimumPixelDelta = 18) {
  const firstImage = await decodePng(first);
  const secondImage = await decodePng(second);
  assert.deepEqual(firstImage.info, secondImage.info, "GPU probe animation samples changed dimensions");
  const {width, height} = firstImage.info;
  let changed = 0;
  let sampled = 0;
  for (let y = Math.floor(height * 0.3); y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const offset = (y * width + x) * 3;
      const delta = Math.abs(firstImage.data[offset] - secondImage.data[offset])
        + Math.abs(firstImage.data[offset + 1] - secondImage.data[offset + 1])
        + Math.abs(firstImage.data[offset + 2] - secondImage.data[offset + 2]);
      if (delta >= minimumPixelDelta) changed += 1;
      sampled += 1;
    }
  }
  return changed / sampled;
}

async function environmentViewDifference(first, second, lookUp) {
  const source = await decodePng(first);
  const reference = await decodePng(second);
  assert.deepEqual(source.info, reference.info, "Environment visibility comparison changed image dimensions");
  const {width, height} = source.info;
  const top = Math.floor(height * (lookUp ? 0.05 : 0.35));
  const bottom = Math.floor(height * (lookUp ? 0.95 : 0.65));
  const left = Math.floor(width * 0.1);
  const right = Math.floor(width * 0.9);
  let changed = 0;
  for (let y = top; y < bottom; y += 1) {
    for (let x = left; x < right; x += 1) {
      const offset = (y * width + x) * 3;
      const difference = Math.abs(source.data[offset] - reference.data[offset])
        + Math.abs(source.data[offset + 1] - reference.data[offset + 1])
        + Math.abs(source.data[offset + 2] - reference.data[offset + 2]);
      if (difference >= 6) changed += 1;
    }
  }
  return changed / ((bottom - top) * (right - left));
}

async function redGreenBalance(png) {
  const {data, info} = await decodePng(png);
  let balance = 0;
  let sampled = 0;
  for (let y = 0; y < info.height; y += 1) {
    for (let x = 0; x < info.width; x += 1) {
      const offset = (y * info.width + x) * 3;
      const red = data[offset];
      const green = data[offset + 1];
      const blue = data[offset + 2];
      if (Math.max(red, green) <= blue + 8) continue;
      balance += green - red;
      sampled += 1;
    }
  }
  assert.ok(sampled > 1_000, `GPU probe translucent tint sample is too small: ${sampled}`);
  return balance / sampled;
}

async function orbitCameraHalfTurn(page, canvas) {
  const bounds = await canvas.boundingBox();
  assert.ok(bounds !== null, "GPU probe transparency canvas has no bounds");
  for (let drag = 0; drag < 4; drag += 1) {
    await page.mouse.move(bounds.x + bounds.width * 0.8, bounds.y + bounds.height * 0.5);
    await page.mouse.down();
    await page.mouse.move(bounds.x + bounds.width * 0.2, bounds.y + bounds.height * 0.5, {steps: 12});
    await page.mouse.up();
  }
  // The renderer deliberately sorts at most one translucent mesh per frame.
  // Waiting for wall-clock time is not equivalent to observing render frames
  // when software WebGL shares a busy CI host, so wait for four actual frame
  // boundaries before sampling the post-turn ordering.
  await page.evaluate(() => new Promise((resolve) => {
    let remaining = 4;
    const next = () => {
      remaining -= 1;
      if (remaining === 0) resolve();
      else requestAnimationFrame(next);
    };
    requestAnimationFrame(next);
  }));
}

async function restoreContext(page) {
  await page.evaluate(() => new Promise((resolve, reject) => {
    const canvas = document.querySelector("[data-gpu-render-probe]");
    if (!(canvas instanceof HTMLCanvasElement)) {
      reject(new Error("GPU probe canvas is unavailable"));
      return;
    }
    const context = canvas.getContext("webgl2");
    const extension = context?.getExtension("WEBGL_lose_context");
    if (extension === null || extension === undefined) {
      reject(new Error("GPU probe browser does not expose WEBGL_lose_context"));
      return;
    }
    const timeout = setTimeout(() => reject(new Error("GPU probe WebGL context did not restore")), 10_000);
    canvas.addEventListener("webglcontextlost", (event) => {
      event.preventDefault();
      setTimeout(() => extension.restoreContext(), 80);
    }, {once: true});
    canvas.addEventListener("webglcontextrestored", () => {
      clearTimeout(timeout);
      requestAnimationFrame(() => requestAnimationFrame(resolve));
    }, {once: true});
    extension.loseContext();
  }));
}

function assertVisibleScene(name, metrics) {
  const evidence = `${name}: ${JSON.stringify(metrics)}`;
  assert.ok(metrics.nearBlackRatio < 0.82, `GPU probe scene is predominantly black; ${evidence}`);
  assert.ok(metrics.colorfulRatio > 0.08, `GPU probe scene lost color channels; ${evidence}`);
  assert.ok(metrics.quantizedColors > 48, `GPU probe scene lost material/texture diversity; ${evidence}`);
  assert.ok(metrics.meanHorizontalEdgeDelta > 0.8, `GPU probe scene lost visible geometry edges; ${evidence}`);
}

function assertVisibleAnimationScene(name, metrics) {
  const evidence = `${name}: ${JSON.stringify(metrics)}`;
  assert.ok(metrics.nearBlackRatio < 0.82, `GPU probe animation scene is predominantly black; ${evidence}`);
  assert.ok(metrics.colorfulRatio > 0.08, `GPU probe animation scene lost color channels; ${evidence}`);
  assert.ok(metrics.quantizedColors > 12, `GPU probe animation scene lost its authored texture; ${evidence}`);
  assert.ok(metrics.meanHorizontalEdgeDelta > 0.5, `GPU probe animation scene lost visible geometry edges; ${evidence}`);
}

function assertVisibleTransparencyOracle(name, metrics) {
  const evidence = `${name}: ${JSON.stringify(metrics)}`;
  assert.ok(metrics.nearBlackRatio < 0.82, `GPU probe transparency oracle is predominantly black; ${evidence}`);
  assert.ok(metrics.colorfulRatio > 0.08, `GPU probe transparency oracle lost color channels; ${evidence}`);
  assert.ok(metrics.quantizedColors > 8, `GPU probe transparency oracle lost its controlled materials; ${evidence}`);
  assert.ok(metrics.meanHorizontalEdgeDelta > 0.1, `GPU probe transparency oracle lost visible geometry edges; ${evidence}`);
}

const environmentSceneNames = new Set(["day", "night", "clouds", "rain", "snow", "lightning"]);
const environmentViewSceneNames = new Set(["clouds-sky", "rain-eye", "snow-eye"]);

function assertVisibleEnvironmentScene(name, metrics) {
  const evidence = `${name}: ${JSON.stringify(metrics)}`;
  assert.ok(metrics.nearBlackRatio < 0.96, `GPU probe environment scene is effectively black; ${evidence}`);
  if (name === "night") {
    assert.ok(metrics.lowLightRatio < 0.82, `GPU probe night lost navigable terrain detail; ${evidence}`);
    assert.ok(metrics.meanLuminance > 16, `GPU probe night is too dark to read; ${evidence}`);
  }
  if (name === "lightning") {
    assert.ok(metrics.nearBlackRatio < 0.2, `GPU probe lightning flash did not illuminate the scene; ${evidence}`);
    assert.ok(metrics.meanLuminance < 175, `GPU probe lightning flash washed out the scene; ${evidence}`);
    assert.ok(metrics.nearWhiteRatio < 0.18, `GPU probe lightning clipped too much scene detail; ${evidence}`);
    assert.ok(metrics.quantizedColors > 8, `GPU probe lightning lost all scene detail; ${evidence}`);
    assert.ok(metrics.meanHorizontalEdgeDelta > 0.05, `GPU probe lightning lost visible geometry edges; ${evidence}`);
    return;
  }
  assert.ok(metrics.colorfulRatio > 0.01, `GPU probe environment scene lost color channels; ${evidence}`);
  assert.ok(metrics.quantizedColors > 12, `GPU probe environment scene lost sky/material diversity; ${evidence}`);
  assert.ok(metrics.meanHorizontalEdgeDelta > 0.2, `GPU probe environment scene lost visible geometry edges; ${evidence}`);
}

function assertEnvironmentStats(name, payload) {
  const environment = payload.environment;
  assert.equal(environment.environmentTextureReady, true, `GPU probe ${name} environment map is not ready`);
  assert.equal(environment.environmentTextureUpdates, 1, `GPU probe ${name} rebuilt an unchanged environment map`);
  const samplesPrecipitationGround = environment.precipitation !== "none" && environment.precipitationIntensity > 0;
  assert.equal(
    environment.rainSplashGrounded,
    samplesPrecipitationGround,
    `GPU probe ${name} reported the wrong precipitation-ground state`,
  );
  assert.equal(
    environment.rainSplashGroundY,
    samplesPrecipitationGround ? payload.weatherGroundY : null,
    `GPU probe ${name} reported the wrong precipitation-ground height`,
  );
  assert.ok(environment.shadowCasters > 0, `GPU probe ${name} registered no terrain shadow casters`);
  assert.ok(environment.activeShadowCasters > 0, `GPU probe ${name} activated no camera-local shadow casters`);
  assert.ok(environment.activeShadowCasters <= environment.shadowCasters, `GPU probe ${name} activated unknown shadow casters`);
  assert.equal(payload.environmentPreset, name, `GPU probe ${name} reported the wrong environment preset`);
  switch (name) {
    case "day":
      assert.equal(environment.precipitation, "none");
      assert.equal(environment.cloudiness, 0);
      assert.equal(environment.sunVisible, true);
      assert.equal(environment.moonVisible, false);
      assert.equal(environment.lightningSequence, null);
      break;
    case "night":
      assert.equal(environment.precipitation, "none");
      assert.equal(environment.sunVisible, false);
      assert.equal(environment.moonVisible, true);
      assert.ok(environment.starVisibility > 0.5, `GPU probe night has no visible star field: ${environment.starVisibility}`);
      assert.equal(environment.lightningSequence, null);
      break;
    case "clouds":
      assert.equal(environment.precipitation, "none");
      assert.equal(environment.cloudiness, 0.9);
      assert.equal(environment.lightningSequence, null);
      break;
    case "rain":
      assert.equal(environment.precipitation, "rain");
      assert.equal(environment.precipitationIntensity, 1);
      assert.ok(environment.activeRainParticles > 0, "GPU probe rain emitted no particles");
      if (payload.environmentView === "eye-level") {
        assert.ok(environment.activeRainSplashes > 0, "GPU probe eye-level rain emitted no splash particles");
        assert.ok(environment.rainSplashContacts > 0, "GPU probe eye-level rain recorded no surface impacts");
      } else assert.equal(environment.rainSplashContacts, 0, "High-altitude rain cannot impact terrain below its local particle window");
      assert.equal(environment.activeSnowParticles, 0);
      assert.equal(environment.lightningSequence, null);
      break;
    case "snow":
      assert.equal(environment.precipitation, "snow");
      assert.equal(environment.precipitationIntensity, 1);
      assert.ok(environment.activeSnowParticles > 0, "GPU probe snow emitted no particles");
      assert.equal(environment.activeRainParticles, 0);
      assert.equal(environment.activeRainSplashes, 0);
      assert.equal(environment.rainSplashContacts, 0);
      if (payload.environmentView === "eye-level") {
        assert.ok(environment.activeSnowSplashes > 0, "GPU probe eye-level snow retained no landed flakes");
        assert.ok(environment.snowSplashContacts > 0, "GPU probe eye-level snow recorded no surface impacts");
      }
      assert.equal(environment.lightningSequence, null);
      break;
    case "lightning":
      assert.equal(environment.precipitation, "rain");
      assert.equal(environment.precipitationIntensity, 1);
      assert.ok(environment.activeRainParticles > 0, "GPU probe lightning storm emitted no rain particles");
      assert.equal(environment.lightningSequence, 74);
      assert.equal(environment.rainSplashContacts, 0, "High-altitude lightning cannot manufacture ground splashes");
      break;
    default:
      throw new Error(`Unknown GPU probe environment scene ${name}`);
  }
}

function stableEnvironmentStats(stats) {
  const {
    activeRainParticles: _activeRainParticles,
    activeSnowParticles: _activeSnowParticles,
    activeRainSplashes: _activeRainSplashes,
    activeSnowSplashes: _activeSnowSplashes,
    rainSplashContacts: _rainSplashContacts,
    snowSplashContacts: _snowSplashContacts,
    ...stable
  } = stats;
  return stable;
}

function stableSurfaceStats(stats) {
  const {
    uploadQueuedChunks: _uploadQueuedChunks,
    translucentSortQueuedMeshes: _translucentSortQueuedMeshes,
    forwardX: _forwardX,
    forwardY: _forwardY,
    forwardZ: _forwardZ,
    ...stable
  } = stats;
  return stable;
}

let server = null;
let browser = null;
let mainFailure = noFailure;
let successMessage = null;
const cleanupFailures = [];
try {
  await rm(evidenceRoot, {recursive: true, force: true});
  await mkdir(evidenceRoot, {recursive: true});
  await boundedOperation("GPU probe bundle build", bundleBuildTimeoutMs, () => build({
    entryPoints: [entryPath],
    outfile: bundlePath,
    bundle: true,
    format: "esm",
    platform: "browser",
    target: ["chrome140"],
    // Core-only Velar packages have no JavaScript package export. Exercise the
    // exact world module compiled into this renderer's production closure.
    alias: {"@openvoxel/world": join(renderingRoot, "dist", "__velar_packages__", "@openvoxel", "world", "src", "index.js")},
    sourcemap: "inline",
    logLevel: "silent",
  }));

  const [html, bundle, resourcePackText] = await Promise.all([
    readFile(htmlPath),
    readFile(bundlePath),
    readFile(resourcePackPath, "utf8"),
  ]);
  const resourcePack = JSON.parse(resourcePackText);
  assert.ok(Array.isArray(resourcePack.animations), "GPU probe resource pack has no animation list");
  const animationScenes = resourcePack.animations.map((animation) => {
    assert.equal(typeof animation.key, "string", "GPU probe animation has no key");
    assert.ok(Array.isArray(animation.frames) && animation.frames.length > 1, `GPU probe animation has fewer than two frames: ${animation.key}`);
    assert.ok(Number.isFinite(animation.frameDurationMs), `GPU probe animation has no frame duration: ${animation.key}`);
    return {
      name: `animation:${animation.key}`,
      evidenceName: `animation-${animation.key.replace(/^.*\//, "").replaceAll(/[^a-z0-9-]/gi, "-")}`,
      query: new URLSearchParams({scene: "animation", animation: animation.key}),
      animation,
    };
  });
  const animationKeys = new Set(animationScenes.map((scene) => scene.animation.key));
  assert.equal(animationKeys.size, resourcePack.animations.length, "GPU probe animation keys must be unique");
  assert.ok(animationKeys.has("openvoxel:animation/water"), "GPU probe must exercise built-in water animation");
  assert.ok(animationKeys.has("openvoxel:animation/magma"), "GPU probe must exercise built-in magma animation");
  server = createServer((request, response) => {
    const path = new URL(request.url ?? "/", "http://127.0.0.1").pathname;
    if (path === "/" || path === "/index.html") {
      response.writeHead(200, {"content-type": "text/html; charset=utf-8", "cache-control": "no-store"});
      response.end(html);
      return;
    }
    if (path === "/probe.js") {
      response.writeHead(200, {"content-type": "text/javascript; charset=utf-8", "cache-control": "no-store"});
      response.end(bundle);
      return;
    }
    response.writeHead(404, {"content-type": "text/plain; charset=utf-8"});
    response.end("Not found");
  });
  const origin = await listen(server);
  browser = await chromium.launch({headless: true});
  const results = new Map();
  const images = new Map();
  const requestedScene = process.env.OPENVOXEL_GPU_SCENE ?? null;
  const staticScenes = [
    "states",
    "layers",
    "seams",
    "transparency",
    "transparency-depth-occluded",
    "transparency-depth-reference",
    "transparency-sort-forward",
    "transparency-sort-reversed",
    "transparency-sort-translated",
    "pbr",
    "pbr-normal",
    "pbr-material",
    "pbr-emissive",
    "day",
    "night",
    "clouds",
    "rain",
    "snow",
    "lightning",
    "shadows",
    "cutout-shadows",
    "seasons",
    "clouds-sky",
    "rain-eye",
    "snow-eye",
  ].map((name) => ({
    name,
    evidenceName: name,
    query: new URLSearchParams({scene: name}),
    animation: null,
    settleMs: name === "rain-eye" || name === "snow-eye" ? 1_200 : name === "rain" || name === "snow" ? 800 : 0,
  }));
  for (const scene of [...staticScenes, ...animationScenes]) {
    if (requestedScene !== null && scene.name !== requestedScene) continue;
    process.stdout.write(`[gpu-probe] ${scene.name}\n`);
    const page = await browser.newPage({viewport: {width: 1280, height: 800}, deviceScaleFactor: 1});
    const failures = [];
    const sceneCleanupFailures = [];
    let sceneFailure = noFailure;
    let released = false;
    page.on("pageerror", (error) => {
      failures.push(`pageerror: ${error.message}`);
      process.stderr.write(`[gpu-probe] ${scene.name} pageerror: ${error.stack ?? error.message}\n`);
    });
    page.on("console", (message) => {
      if (message.type() === "error") failures.push(`console: ${message.text()}`);
    });
    try {
      await page.goto(`${origin}/?${scene.query}`, {waitUntil: "networkidle"});
      await page.waitForFunction(() => globalThis.__openVoxelGpuProbe?.ready === true
        || globalThis.__openVoxelGpuProbe?.error !== null, null, {timeout: 30_000});
      if (scene.settleMs > 0) await page.waitForTimeout(scene.settleMs);
      if (scene.name === "rain-eye" || scene.name === "snow-eye") {
        await page.waitForFunction(() => {
          const stats = globalThis.__openVoxelGpuProbeEnvironmentStats();
          return stats.precipitation === "rain" ? stats.activeRainSplashes > 0 : stats.activeSnowSplashes > 0;
        }, null, {timeout: 10_000});
      }
      if (scene.name === "lightning") {
        await page.evaluate(() => globalThis.__openVoxelGpuProbeReplayLightning());
        await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))));
      }
      if (scene.name === "states") {
        assert.deepEqual(
          await page.evaluate(() => globalThis.__openVoxelGpuProbePointerLockReleaseRace()),
          {exitCalls: 1, lockReleased: true, pointerLockedAttribute: "false"},
          "GPU probe left a late pointer-lock request attached to a released canvas",
        );
      }
      const report = await page.evaluate(() => {
        const value = globalThis.__openVoxelGpuProbe;
        return {
          ...value,
          payload: value.payload === null ? null : {
            ...value.payload,
            environment: globalThis.__openVoxelGpuProbeEnvironmentStats(),
          },
        };
      });
      assert.equal(report.error, null, `GPU probe ${scene.name} failed: ${report.error}`);
      assert.equal(report.scene, scene.name);
      assert.equal(report.ready, true);
      const canvas = page.locator("[data-gpu-render-probe]");
      const initial = await canvas.screenshot({path: join(evidenceRoot, `${scene.evidenceName}.png`)});
      images.set(scene.name, initial);
      const metrics = await imageMetrics(initial);
      if (scene.animation !== null) assertVisibleAnimationScene(scene.name, metrics);
      else if (scene.name === "shadows" || scene.name === "cutout-shadows") assertVisibleEnvironmentScene(scene.name, metrics);
      else if (environmentViewSceneNames.has(scene.name)) {
        assert.ok(metrics.nearBlackRatio < 0.95, `GPU ${scene.name} environment is unreadable: ${JSON.stringify(metrics)}`);
        assertEnvironmentStats(report.payload.environmentPreset, report.payload);
      }
      else if (scene.name.startsWith("transparency-depth-") || scene.name.startsWith("transparency-sort-")) {
        assertVisibleTransparencyOracle(scene.name, metrics);
      } else if (environmentSceneNames.has(scene.name)) {
        assertVisibleEnvironmentScene(scene.name, metrics);
        assertEnvironmentStats(scene.name, report.payload);
      } else assertVisibleScene(scene.name, metrics);

      let animationChange = 0;
      const animationSamples = [];
      if (scene.name === "cutout-shadows") {
        const wrappers = await page.evaluate(() => globalThis.__openVoxelGpuProbeCutoutShadowStats());
        assert.equal(wrappers.length, 1, "Cutout oracle must use one shared leaf material");
        assert.equal(wrappers[0].subMeshes, 2, "Cutout oracle must draw leaves in two separate Chunks");
        assert.equal(wrappers[0].effects, 1, "Identical cutout Chunks must share one shadow Effect");
        assert.equal(wrappers[0].disposedMeshReferences, 0);
        await page.evaluate(() => globalThis.__openVoxelGpuProbeCutoutShadows(false));
        await page.waitForTimeout(250);
        const solid = await canvas.screenshot({path: join(evidenceRoot, "cutout-shadows-solid-oracle.png")});
        const cutoutImage = await decodePng(initial);
        const solidImage = await decodePng(solid);
        let illuminated = 0;
        let gainedLight = 0;
        for (let index = 0; index < cutoutImage.data.length; index += 3) {
          const gain = (cutoutImage.data[index] + cutoutImage.data[index + 1] + cutoutImage.data[index + 2]
            - solidImage.data[index] - solidImage.data[index + 1] - solidImage.data[index + 2]) / 3;
          if (gain < 8) continue;
          illuminated += 1;
          gainedLight += gain;
        }
        const cutout = {illuminatedRatio: illuminated / (cutoutImage.info.width * cutoutImage.info.height), meanLightGain: illuminated === 0 ? 0 : gainedLight / illuminated};
        assert.ok(cutout.illuminatedRatio > 0.0005, `Leaf alpha holes must pass sunlight onto the receiver: ${JSON.stringify(cutout)}`);
        assert.ok(cutout.meanLightGain > 12, `Leaf cutout shadow lost meaningful light transmission: ${JSON.stringify(cutout)}`);
        await page.evaluate(() => globalThis.__openVoxelGpuProbeCutoutShadows(true));
        await page.waitForTimeout(250);
        const restored = await canvas.screenshot({path: join(evidenceRoot, "cutout-shadows-restored.png")});
        assert.ok(await changedPixelRatio(initial, restored, 12) < 0.001, "Restoring accurate cutout shadows changed the static scene");
        process.stdout.write(`[gpu-probe] cutout shadow ${JSON.stringify({cutout, wrappers})}\n`);
      }
      if (environmentViewSceneNames.has(scene.name)) {
        const view = await page.evaluate(() => globalThis.__openVoxelGpuProbeEnvironmentView());
        const lookUp = scene.name === "clouds-sky";
        assert.equal(view.cameraKind, "UniversalCamera", "Environment views must use the production first-person camera");
        assert.ok(view.eyeY > 65 && view.eyeY < 68, "Environment view must stay at player eye height");
        assert.ok(lookUp ? view.directionY > 0.8 : Math.abs(view.directionY) < 0.001, `Environment camera points in the wrong direction: ${JSON.stringify(view)}`);
        assert.equal(view.minimumCloudY, 60, "Cloud horizon height must retain its world scale");
        assert.equal(view.maximumCloudY, 600, "Cloud zenith height must retain its world scale");
        assert.equal(view.cloudVertices, 49, "Cloud dome must use the four authored radial bands");
        assert.ok(view.maximumUvWorldError < 0.001, "Cloud texture must not stretch with radial mesh spacing");
        assert.equal(view.cloudFogEnabled, false, "Terrain fog must not obscure the clouds");
        await page.evaluate(() => globalThis.__openVoxelGpuProbeSetEnvironmentEffect(false));
        await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))));
        const disabled = await canvas.screenshot({path: join(evidenceRoot, `${scene.evidenceName}-effect-disabled.png`)});
        const affectedRatio = await environmentViewDifference(initial, disabled, lookUp);
        assert.ok(affectedRatio > (lookUp ? 0.005 : 0.0001), `GPU ${scene.name} effect is invisible in the player's ${lookUp ? "sky" : "eye-level"} view: ${affectedRatio}`);
        process.stdout.write(`[gpu-probe] ${scene.name} visible effect ${JSON.stringify({affectedRatio, ...view})}\n`);
        await page.evaluate(() => globalThis.__openVoxelGpuProbeSetEnvironmentEffect(true));
        if (lookUp) {
          const samples = await page.evaluate(() => globalThis.__openVoxelGpuProbeTextureBlending());
          const background = [0.2, 0.4, 0.6];
          const texel = [64 / 255, 32 / 255, 0];
          for (const [mode, actual] of Object.entries(samples)) {
            const [blend, fadeText = "1"] = mode.split(":");
            const fade = Number(fadeText);
            const alpha = 128 / 255 * fade;
            const expected = background.map((channel, index) => Math.round(255 * (
              blend === "additive" ? channel + texel[index] * fade * alpha : channel * (1 - alpha) + texel[index] * fade
            )));
            for (let channel = 0; channel < 3; channel += 1) {
              assert.ok(Math.abs(actual[channel] - expected[channel]) <= 2, `GPU ${mode} incorrectly multiplied texture alpha: ${actual} expected ${expected}`);
            }
          }
          process.stdout.write(`[gpu-probe] environment premultiplied/additive pixels ${JSON.stringify(samples)}\n`);
        }
      }
      if (scene.name === "seasons") {
        assert.deepEqual(report.payload.tintRoles, [0, 1, 2, 3, 4], "Season fixture must exercise every climate tint role");
        const spring = await page.evaluate(() => globalThis.__openVoxelGpuProbeSeason("spring"));
        assert.ok(spring.meshes.length > 0, "Season fixture has no GPU meshes");
        const climateSamples = {spring: spring.climate};
        for (const season of ["summer", "autumn", "winter"]) {
          const sampled = await page.evaluate((value) => globalThis.__openVoxelGpuProbeSeason(value), season);
          assert.equal(sampled.climate.season, season);
          assert.deepEqual(sampled.meshes, spring.meshes, "Season tint must update existing GPU meshes");
          assert.deepEqual(stableSurfaceStats(sampled.stats), stableSurfaceStats(spring.stats));
          climateSamples[season] = sampled.climate;
          await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))));
          const seasonalImage = await canvas.screenshot({path: join(evidenceRoot, `seasons-${season}.png`)});
          const changed = await changedPixelRatio(initial, seasonalImage);
          assert.ok(changed > 0.005, `Season ${season} has no visible effect: ${changed}`);
        }
        assert.ok(climateSamples.summer.temperatureCelsius > climateSamples.winter.temperatureCelsius + 20);
        report.payload.climateSamples = climateSamples;
        report.payload.environment = await page.evaluate(() => globalThis.__openVoxelGpuProbeEnvironmentStats());
      }
      if (scene.name === "shadows") {
        await page.evaluate(() => globalThis.__openVoxelGpuProbeSetShadows(false));
        await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))));
        const unshadowed = await canvas.screenshot({path: join(evidenceRoot, "shadows-disabled.png")});
        const shadowImage = await decodePng(initial);
        const unshadowedImage = await decodePng(unshadowed);
        let darkened = 0;
        let lightLoss = 0;
        const pixelCount = shadowImage.info.width * shadowImage.info.height;
        for (let index = 0; index < shadowImage.data.length; index += 3) {
          const difference = (unshadowedImage.data[index] + unshadowedImage.data[index + 1] + unshadowedImage.data[index + 2]
            - shadowImage.data[index] - shadowImage.data[index + 1] - shadowImage.data[index + 2]) / 3;
          if (difference < 10) continue;
          darkened += 1;
          lightLoss += difference;
        }
        const contrast = {affectedRatio: darkened / pixelCount, meanLightLoss: darkened === 0 ? 0 : lightLoss / darkened};
        assert.ok(contrast.affectedRatio > 0.001, `GPU shadows must visibly darken the ground: ${JSON.stringify(contrast)}`);
        assert.ok(contrast.meanLightLoss > 18, `GPU shadows are washed out by ambient fill: ${JSON.stringify(contrast)}`);
        process.stdout.write(`[gpu-probe] shadow contrast ${JSON.stringify(contrast)}\n`);
        await page.evaluate(() => globalThis.__openVoxelGpuProbeSetShadows(true));
      }
      if (scene.animation !== null) {
        assert.equal(report.payload.animationKey, scene.animation.key);
        assert.equal(report.payload.frameDurationMs, scene.animation.frameDurationMs);
        assert.deepEqual(report.payload.frames, scene.animation.frames);
        const capturedFrames = await page.evaluate(() => globalThis.__openVoxelGpuProbeAnimationCycle());
        const animationStates = capturedFrames.map(({frame, offset}) => ({frame, offset}));
        assert.ok(capturedFrames.length >= 3, "Animation capture must include a distinct frame and a return to its first frame");
        assert.deepEqual(new Set(animationStates.map(({offset}) => offset)), new Set(report.payload.frameOffsets));
        assert.equal(animationStates.at(-1).offset, animationStates[0].offset);
        let firstFrame = null;
        for (const [sample, capture] of capturedFrames.entries()) {
          assert.ok(capture.png.startsWith("data:image/png;base64,"), "Animation frame readback must be a PNG");
          const animated = Buffer.from(capture.png.slice("data:image/png;base64,".length), "base64");
          await writeFile(join(evidenceRoot, `${scene.evidenceName}-frame-${sample}.png`), animated);
          if (firstFrame === null) {
            firstFrame = animated;
            continue;
          }
          assert.ok(capture.frame > capturedFrames[sample - 1].frame, "Animation samples must come from different render frames");
          assert.notEqual(capture.offset, capturedFrames[sample - 1].offset, "Animation samples must cross a texture frame boundary");
          const sampleChange = await changedPixelRatio(firstFrame, animated, 3);
          animationSamples.push(sampleChange);
          animationChange = Math.max(animationChange, sampleChange);
        }
        assert.ok(animationChange > 0.001, `GPU probe ${scene.animation.key} did not change visible frame pixels: ${animationChange}; states=${JSON.stringify(animationStates)}`);
        assert.ok(Math.min(...animationSamples) < animationChange * 0.25, `GPU probe ${scene.animation.key} did not cycle between distinct frames: ${JSON.stringify(animationSamples)}`);
        report.payload.animationStates = animationStates;
        process.stdout.write(`[gpu-probe] animation ${scene.animation.key} ${JSON.stringify({animationStates, animationSamples})}\n`);
      }
      if (scene.name === "pbr") {
        await restoreContext(page);
        await page.waitForTimeout(500);
        const restored = await canvas.screenshot({path: join(evidenceRoot, `${scene.evidenceName}-restored.png`)});
        assertVisibleScene(`${scene.name}-restored`, await imageMetrics(restored));
        const restoredPixelChange = await changedPixelRatio(initial, restored, 18);
        assert.ok(restoredPixelChange < 0.01, `GPU probe context restore materially changed the static PBR scene: ${restoredPixelChange}`);
        assert.deepEqual(
          stableSurfaceStats(await page.evaluate(() => globalThis.__openVoxelGpuProbeStats())),
          stableSurfaceStats(report.payload.stats),
        );
      }
      if (scene.name === "transparency") {
        const bounds = await canvas.boundingBox();
        assert.ok(bounds !== null, "GPU probe transparency canvas has no bounds");
        await page.mouse.move(bounds.x + bounds.width * 0.68, bounds.y + bounds.height * 0.52);
        await page.mouse.down();
        await page.mouse.move(bounds.x + bounds.width * 0.32, bounds.y + bounds.height * 0.52, {steps: 12});
        await page.mouse.up();
        await page.waitForTimeout(180);
        const reversed = await canvas.screenshot({path: join(evidenceRoot, `${scene.evidenceName}-reversed.png`)});
        assertVisibleScene(`${scene.name}-reversed`, await imageMetrics(reversed));
        assert.ok(await changedPixelRatio(initial, reversed) > 0.04, "GPU probe camera reversal did not materially redraw translucent geometry");
      }
      if (scene.name === "transparency-sort-forward") {
        await orbitCameraHalfTurn(page, canvas);
        const halfTurn = await canvas.screenshot({path: join(evidenceRoot, `${scene.evidenceName}-half-turn.png`)});
        assertVisibleTransparencyOracle(`${scene.name}-half-turn`, await imageMetrics(halfTurn));
        images.set(`${scene.name}:half-turn`, halfTurn);
      }
      if (scene.name === "rain" || scene.name === "rain-eye") {
        await page.evaluate(() => globalThis.__openVoxelGpuProbeSetTerrain(false));
        // The camera-local weather field refreshes terrain columns gradually so
        // a Chunk replacement cannot trigger 149 raycasts in one frame.
        await page.waitForFunction(
          () => globalThis.__openVoxelGpuProbeEnvironmentStats().rainSplashGrounded === false,
          null,
          {timeout: 3_000},
        );
        const withoutTerrain = await page.evaluate(() => globalThis.__openVoxelGpuProbeEnvironmentStats());
        assert.equal(withoutTerrain.rainSplashGrounded, false, "GPU probe rain retained a removed terrain hit");
        assert.equal(withoutTerrain.rainSplashGroundY, null);
        await page.waitForTimeout(600);
        const settled = await page.evaluate(() => globalThis.__openVoxelGpuProbeEnvironmentStats());
        assert.equal(settled.rainSplashContacts, withoutTerrain.rainSplashContacts, "GPU probe rain generated impacts without terrain");
        assert.equal(settled.activeRainSplashes, 0, "GPU probe rain retained expired splashes without terrain");
        await page.evaluate(() => globalThis.__openVoxelGpuProbeSetTerrain(true));
        await page.waitForTimeout(100);
        await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))));
      }
      const lifecycle = await page.evaluate(() => globalThis.__openVoxelGpuProbeRelease());
      released = true;
      assert.deepEqual(
        stableSurfaceStats(lifecycle.statsBeforeRelease),
        stableSurfaceStats(report.payload.stats),
        `GPU probe ${scene.name} released a different surface`,
      );
      assert.deepEqual(
        stableEnvironmentStats(lifecycle.environmentStatsBeforeRelease),
        stableEnvironmentStats(report.payload.environment),
        `GPU probe ${scene.name} released a different environment`,
      );
      assert.equal(lifecycle.statsRejected, true, `GPU probe ${scene.name} stats remained available after release`);
      assert.equal(lifecycle.statsError, "Voxel surface is released", `GPU probe ${scene.name} returned the wrong post-release error`);
      assert.equal(lifecycle.environmentStatsRejected, true, `GPU probe ${scene.name} environment stats remained available after release`);
      assert.equal(lifecycle.environmentStatsError, "Voxel surface is released", `GPU probe ${scene.name} returned the wrong post-release environment error`);
      assert.deepEqual(failures, [], `GPU probe ${scene.name} emitted browser errors`);
      results.set(scene.name, {...report.payload, metrics, animationChange, animationSamples});
    } catch (error) {
      sceneFailure = error;
    } finally {
      if (!released && !page.isClosed()) {
        await attemptCleanup(sceneCleanupFailures, `GPU probe ${scene.name} surface release`, () => (
          boundedOperation(`GPU probe ${scene.name} surface release`, pageCleanupTimeoutMs, () => (
            page.evaluate(() => globalThis.__openVoxelGpuProbeRelease?.())
          ))
        ));
      }
      await attemptCleanup(sceneCleanupFailures, `GPU probe ${scene.name} page close`, () => (
        boundedOperation(`GPU probe ${scene.name} page close`, pageCleanupTimeoutMs, () => page.close())
      ));
    }
    if (sceneFailure !== noFailure) {
      reportCleanupFailures(`GPU probe ${scene.name} failure`, sceneCleanupFailures);
      throw sceneFailure;
    }
    if (sceneCleanupFailures.length > 0) {
      throw new AggregateError(sceneCleanupFailures, `GPU probe ${scene.name} cleanup failed`);
    }
  }

  if (requestedScene !== null) {
    assert.ok(results.has(requestedScene), `Unknown requested GPU probe scene: ${requestedScene}`);
    successMessage = `GPU render probe scene ${requestedScene} passed; evidence: ${evidenceRoot}`;
  } else {
  const states = results.get("states");
  assert.equal(states.catalogStates, states.sourceStates);
  assert.ok(states.catalogStates > 1);
  assert.equal(states.meshedStates, states.visibleStates);
  assert.equal(new Set(states.runtimeIds).size, states.visibleStates);
  assert.equal(states.stats.chunks, 1);
  assert.ok(states.stats.meshes > 0 && states.stats.quads > states.visibleStates);

  const layers = results.get("layers");
  assert.equal(layers.accessedLayers, layers.expectedLayers);
  assert.ok(layers.submittedLayers > 0 && layers.animatedLayers > 0);
  assert.deepEqual(layers.channels, ["albedo", "normal", "material", "emissive"]);
  assert.equal(layers.stats.chunks, 1);

  const seams = results.get("seams");
  assert.equal(seams.opaque.culledQuads, seams.opaque.expectedCulledQuads);
  assert.equal(seams.crossTypeLeaves.culledQuads, seams.crossTypeLeaves.expectedCulledQuads);
  assert.ok(seams.opaque.isolatedQuads > seams.opaque.joinedQuads);
  assert.ok(seams.crossTypeLeaves.isolatedQuads > seams.crossTypeLeaves.joinedQuads);
  assert.equal(seams.stats.chunks, 2);
  assert.equal(seams.opaque.runtimeIds.length, 1);
  assert.equal(seams.crossTypeLeaves.runtimeIds.length, 2);

  const transparency = results.get("transparency");
  assert.ok(transparency.translucentBatches >= 3);
  assert.ok(transparency.translucentQuads > 0);
  assert.deepEqual(transparency.materials, [
    "openvoxel:material/ice",
    "openvoxel:material/magma",
    "openvoxel:material/water",
  ]);
  assert.equal(transparency.stats.chunks, 2);

  const depthOccluded = results.get("transparency-depth-occluded");
  const depthReference = results.get("transparency-depth-reference");
  assert.equal(depthOccluded.hiddenPanel, true);
  assert.equal(depthOccluded.translucentQuads, 1);
  assert.equal(depthReference.hiddenPanel, false);
  assert.equal(depthReference.translucentQuads, 0);
  const hiddenPanelChange = await changedPixelRatio(
    images.get("transparency-depth-occluded"),
    images.get("transparency-depth-reference"),
    3,
  );
  assert.ok(hiddenPanelChange < 0.0001, `GPU probe translucent panel passed through opaque depth: ${hiddenPanelChange}`);

  const sortForward = results.get("transparency-sort-forward");
  const sortReversed = results.get("transparency-sort-reversed");
  const sortTranslated = results.get("transparency-sort-translated");
  assert.equal(sortForward.panelCount, 2);
  assert.equal(sortForward.reverseSubmission, false);
  assert.equal(sortReversed.reverseSubmission, true);
  assert.equal(sortTranslated.chunkX, 2);
  const submissionOrderChange = await changedPixelRatio(
    images.get("transparency-sort-forward"),
    images.get("transparency-sort-reversed"),
    3,
  );
  assert.ok(submissionOrderChange < 0.0001, `GPU probe translucent output depends on quad submission order: ${submissionOrderChange}`);
  const translatedSortChange = await changedPixelRatio(
    images.get("transparency-sort-forward"),
    images.get("transparency-sort-translated"),
    3,
  );
  assert.ok(translatedSortChange < 0.0001, `GPU probe translucent sorting changed after equivalent Chunk translation: ${translatedSortChange}`);
  const forwardTintBalance = await redGreenBalance(images.get("transparency-sort-forward"));
  const halfTurnTintBalance = await redGreenBalance(images.get("transparency-sort-forward:half-turn"));
  assert.ok(forwardTintBalance > 20, `GPU probe initial translucent order did not put the green panel in front: ${forwardTintBalance}`);
  assert.ok(halfTurnTintBalance < -10, `GPU probe camera movement did not re-sort the red panel in front: ${halfTurnTintBalance}`);

  const pbr = results.get("pbr");
  assert.equal(pbr.neutralChannel, null);
  assert.equal(pbr.panels.length, 6);
  assert.deepEqual(pbr.channels, ["normal", "material", "emissive"]);
  const pbrChannelChanges = {};
  for (const channel of pbr.channels) {
    const variant = results.get(`pbr-${channel}`);
    assert.equal(variant.neutralChannel, channel);
    assert.deepEqual(variant.panels, pbr.panels);
    // Authored emissive maps encode low-energy sRGB radiance. Once converted to
    // linear light and tone-mapped, their valid contribution is intentionally
    // subtler than a tangent-normal or ORM replacement, so measure that channel
    // with a lower per-pixel floor while retaining the same affected-area gate.
    const minimumPixelDelta = channel === "emissive" ? 2 : 18;
    pbrChannelChanges[channel] = await changedPixelRatio(
      images.get("pbr"),
      images.get(`pbr-${channel}`),
      minimumPixelDelta,
    );
    assert.ok(pbrChannelChanges[channel] > 0.0005, `GPU probe ${channel} channel does not affect rendered pixels: ${pbrChannelChanges[channel]}`);
  }

  const environmentChanges = {
    nightFromDay: await changedPixelRatio(images.get("day"), images.get("night"), 18),
    cloudsFromDay: await changedPixelRatio(images.get("day"), images.get("clouds"), 10),
    rainFromClouds: await changedPixelRatio(images.get("clouds"), images.get("rain"), 10),
    snowFromClouds: await changedPixelRatio(images.get("clouds"), images.get("snow"), 10),
    snowFromRain: await changedPixelRatio(images.get("rain"), images.get("snow"), 10),
    lightningFromRain: await changedPixelRatio(images.get("rain"), images.get("lightning"), 64),
  };
  assert.ok(environmentChanges.nightFromDay > 0.05, `GPU probe day/night lighting is not visually distinct: ${environmentChanges.nightFromDay}`);
  assert.ok(environmentChanges.cloudsFromDay > 0.005, `GPU probe cloud cover does not affect rendered pixels: ${environmentChanges.cloudsFromDay}`);
  assert.ok(environmentChanges.rainFromClouds > 0.005, `GPU probe rain does not affect rendered pixels: ${environmentChanges.rainFromClouds}`);
  assert.ok(environmentChanges.snowFromClouds > 0.005, `GPU probe snow does not affect rendered pixels: ${environmentChanges.snowFromClouds}`);
  assert.ok(environmentChanges.snowFromRain > 0.002, `GPU probe rain and snow are not visually distinct: ${environmentChanges.snowFromRain}`);
  assert.ok(environmentChanges.lightningFromRain > 0.001, `GPU probe lightning does not produce a visible flash/bolt: ${environmentChanges.lightningFromRain}`);

  const animationChanges = {};
  for (const scene of animationScenes) {
    const animation = results.get(scene.name);
    assert.equal(animation.stats.chunks, 1);
    assert.equal(animation.frames.length, scene.animation.frames.length);
    assert.ok(animation.animationChange > 0.001);
    assert.ok(Math.min(...animation.animationSamples) < animation.animationChange * 0.25);
    animationChanges[scene.animation.key] = animation.animationChange;
  }

    successMessage = `GPU render probe passed; transparency changes ${JSON.stringify({hiddenPanelChange, submissionOrderChange, translatedSortChange, forwardTintBalance, halfTurnTintBalance})}; animation pixel changes ${JSON.stringify(animationChanges)}; PBR pixel changes ${JSON.stringify(pbrChannelChanges)}; environment pixel changes ${JSON.stringify(environmentChanges)}; evidence: ${evidenceRoot}`;
  }
} catch (error) {
  mainFailure = error;
} finally {
  if (browser !== null) {
    await attemptCleanup(cleanupFailures, "GPU probe browser close", () => (
      boundedOperation("GPU probe browser close", browserCloseTimeoutMs, () => browser.close())
    ));
  }
  if (server !== null) {
    await attemptCleanup(cleanupFailures, "GPU probe HTTP server close", () => (
      boundedOperation("GPU probe HTTP server close", serverCloseTimeoutMs, () => closeServer(server))
    ));
  }
  await attemptCleanup(cleanupFailures, "GPU probe temporary directory removal", () => (
    boundedOperation("GPU probe temporary directory removal", temporaryCleanupTimeoutMs, () => (
      rm(temporaryRoot, {recursive: true, force: true})
    ))
  ));
}

if (mainFailure !== noFailure) {
  reportCleanupFailures("GPU render probe failure", cleanupFailures);
  throw mainFailure;
}
if (cleanupFailures.length > 0) throw new AggregateError(cleanupFailures, "GPU render probe cleanup failed");
assert.notEqual(successMessage, null, "GPU render probe completed without a result summary");
console.log(successMessage);
