import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";
import { chromium } from "playwright";

const projectRoot = fileURLToPath(new URL("../", import.meta.url));
const velarCli = join(projectRoot, "node_modules", "@velarscript", "cli", "dist", "cli.js");
const runtimeDirectory = await mkdtemp(join(tmpdir(), "openvoxel-browser-"));
const processes = [];

function start(name, args, options = {}) {
  const output = [];
  const child = spawn(process.execPath, [velarCli, ...args], {
    cwd: options.cwd ?? projectRoot,
    env: { ...process.env, ...options.env },
    stdio: ["ignore", "pipe", "pipe"],
  });
  for (const stream of [child.stdout, child.stderr]) {
    stream.setEncoding("utf8");
    stream.on("data", (chunk) => {
      output.push(chunk);
      if (output.length > 200) output.shift();
    });
  }
  const processInfo = { name, child, output };
  processes.push(processInfo);
  return processInfo;
}

function processFailure(processInfo) {
  return `${processInfo.name} exited before it became ready:\n${processInfo.output.join("")}`;
}

async function waitForUrl(url, processInfo, timeoutMilliseconds = 30_000) {
  const deadline = Date.now() + timeoutMilliseconds;
  while (Date.now() < deadline) {
    if (processInfo.child.exitCode !== null) throw new Error(processFailure(processInfo));
    try {
      const response = await fetch(url);
      if (response.ok) return;
    } catch {
      // The listener may not exist yet.
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`${processInfo.name} did not become ready at ${url}\n${processInfo.output.join("")}`);
}

async function stop(processInfo) {
  if (processInfo.child.exitCode !== null) return;
  processInfo.child.kill("SIGTERM");
  const exited = new Promise((resolve) => processInfo.child.once("exit", resolve));
  let timeoutId;
  const timeout = new Promise((resolve) => {
    timeoutId = setTimeout(resolve, 5_000, "timeout");
  });
  const result = await Promise.race([exited, timeout]);
  clearTimeout(timeoutId);
  if (result === "timeout" && processInfo.child.exitCode === null) {
    processInfo.child.kill("SIGKILL");
    await exited;
  }
}

async function text(page, selector) {
  const value = await page.locator(selector).textContent();
  assert.notEqual(value, null, `${selector} must contain text`);
  return value.trim();
}

let browser = null;
try {
  const build = start("Web build", ["build", "apps/web"]);
  await new Promise((resolve, reject) => {
    build.child.once("error", reject);
    build.child.once("exit", (code) => code === 0 ? resolve() : reject(new Error(processFailure(build))));
  });

  const server = start("OpenVoxel server", ["serve"], {
    cwd: join(projectRoot, "apps", "server"),
    env: {
      OPENVOXEL_DB: join(runtimeDirectory, "acceptance.sqlite"),
      OPENVOXEL_LOGGER: "false",
    },
  });
  await waitForUrl("http://127.0.0.1:3000/api/health", server);

  const preview = start("Web preview", ["preview", "apps/web", "--port", "4173"]);
  await waitForUrl("http://127.0.0.1:4173/", preview);

  browser = await chromium.launch({ headless: true });
  const page = await browser.newPage();
  const browserFailures = [];
  page.on("pageerror", (error) => browserFailures.push(`pageerror: ${error.message}`));
  page.on("console", (message) => {
    if (message.type() === "error") browserFailures.push(`console: ${message.text()}`);
  });

  const worldId = `browser-${Date.now()}`;
  await page.goto("http://127.0.0.1:4173/", { waitUntil: "networkidle" });
  await page.locator("[data-world-id-input]").fill(worldId);
  await page.locator("[data-world-name-input]").fill("Browser Acceptance");
  await page.locator("[data-seed-input]").fill("browser-acceptance-seed");
  await page.locator("[data-create-world]").click();
  await page.locator('[data-world-ready="true"]').waitFor();

  assert.equal(await text(page, "[data-world-id]"), worldId);
  assert.equal(await text(page, "[data-revision]"), "0");
  assert.equal(await text(page, "[data-generation]"), "1");
  const initialRuntimeId = await text(page, "[data-runtime-id]");
  assert.notEqual(initialRuntimeId, "-1");

  await page.locator("[data-edit-spawn]").click();
  await page.locator("[data-revision]").filter({ hasText: "1" }).waitFor();
  const editedRuntimeId = await text(page, "[data-runtime-id]");
  assert.notEqual(editedRuntimeId, initialRuntimeId);

  await page.locator("[data-reconnect]").click();
  await page.locator("[data-generation]").filter({ hasText: "2" }).waitFor();
  assert.equal(await text(page, "[data-revision]"), "1");
  assert.equal(await text(page, "[data-runtime-id]"), editedRuntimeId);

  await page.reload({ waitUntil: "networkidle" });
  await page.locator("[data-world-id-input]").fill(worldId);
  await page.locator("[data-open-world]").click();
  await page.locator('[data-world-ready="true"]').waitFor();
  assert.equal(await text(page, "[data-revision]"), "1");
  assert.equal(await text(page, "[data-runtime-id]"), editedRuntimeId);
  assert.deepEqual(browserFailures, []);

  console.log(`Browser acceptance passed for ${worldId}`);
} finally {
  if (browser !== null) await browser.close();
  for (const processInfo of processes.reverse()) await stop(processInfo);
  await rm(runtimeDirectory, { recursive: true, force: true });
}
