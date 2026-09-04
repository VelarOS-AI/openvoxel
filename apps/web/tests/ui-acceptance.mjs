import assert from "node:assert/strict";
import { mkdir } from "node:fs/promises";
import { createServer } from "node:net";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";
import { chromium } from "playwright";

const projectRoot = fileURLToPath(new URL("../../../", import.meta.url));
const velarCli = join(projectRoot, "node_modules", "@velarscript", "cli", "dist", "cli.js");
const screenshotsDirectory = join(projectRoot, "apps", "web", "generated", "ui-acceptance");
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

async function createWorld(page, world) {
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
  await page.locator('[data-render-status]').filter({ hasText: "Building" }).waitFor({ timeout: 60_000 });
  await page.locator('[data-render-status]').filter({ hasText: "World ready" }).waitFor({ timeout: 120_000 });
  assert.equal(await page.locator('[data-error]').count(), 0);
}

async function moveAcrossChunkBoundary(page) {
  await page.locator('[data-voxel-canvas]').click({position: {x: 320, y: 240}});
  await page.keyboard.down("Shift");
  await page.keyboard.down("w");
  await page.waitForTimeout(1_200);
  await page.keyboard.up("w");
  await page.keyboard.up("Shift");
  await page.locator('[data-render-status]').filter({ hasText: "Building" }).waitFor({ timeout: 60_000 });
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
    seed: "",
  };
  await createWorld(page, coast);
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
  await createWorld(page, highlands);
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
