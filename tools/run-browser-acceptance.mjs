import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";
import { chromium } from "playwright";

const projectRoot = fileURLToPath(new URL("../", import.meta.url));
const velarCli = join(projectRoot, "node_modules", "@velarscript", "cli", "dist", "cli.js");
const npmCli = process.env.npm_execpath;
assert.equal(typeof npmCli, "string", "Run browser acceptance through npm run test:browser");
const runtimeDirectory = await mkdtemp(join(tmpdir(), "openvoxel-browser-"));
const processes = [];

function start(name, entry, args, options = {}) {
  const output = [];
  const child = spawn(process.execPath, [entry, ...args], {
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

async function requireSuccess(processInfo) {
  await new Promise((resolve, reject) => {
    processInfo.child.once("error", reject);
    processInfo.child.once("exit", (code) => code === 0 ? resolve() : reject(new Error(processFailure(processInfo))));
  });
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

async function selectBackend(page, mode) {
  await page.locator(`[data-use-${mode}]`).click();
  await page.locator(`[data-use-${mode}][aria-pressed="true"]`).waitFor();
  assert.match(await text(page, "[data-backend-mode]"), mode === "local" ? /LocalBackend/u : /OnlineBackend/u);
}

async function runConformance(page, mode, baseWorldId) {
  await page.locator("[data-world-id-input]").fill(baseWorldId);
  await page.locator("[data-world-name-input]").fill(`${mode} Backend Conformance`);
  await page.locator("[data-seed-input]").fill(`${mode}-backend-conformance-seed`);
  await page.locator("[data-verify-backend]").click();
  try {
    await page.locator('[data-conformance-pass="true"]').waitFor();
  } catch (error) {
    const status = await text(page, "[data-status]");
    const failureNode = page.locator("[data-error]");
    const failure = await failureNode.count() === 0 ? null : await failureNode.textContent();
    throw new Error(`${mode} conformance did not pass: ${status}; ${failure ?? "no visible failure"}`, { cause: error });
  }
  assert.equal(await text(page, "[data-conformance-world]"), `${baseWorldId}-${mode}-conformance`);
  assert.equal(await text(page, "[data-conformance-revision]"), "1");
  assert.equal(await text(page, "[data-conformance-generation]"), "2");
}

async function createEditReconnect(page, worldId, mode) {
  await page.locator("[data-world-id-input]").fill(worldId);
  await page.locator("[data-world-name-input]").fill(`${mode} Browser Acceptance`);
  await page.locator("[data-seed-input]").fill(`${mode}-browser-acceptance-seed`);
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
  return editedRuntimeId;
}

async function openPersisted(page, worldId, editedRuntimeId) {
  await page.locator("[data-world-id-input]").fill(worldId);
  await page.locator("[data-open-world]").click();
  await page.locator('[data-world-ready="true"]').waitFor();
  assert.equal(await text(page, "[data-world-id]"), worldId);
  assert.equal(await text(page, "[data-revision]"), "1");
  assert.equal(await text(page, "[data-runtime-id]"), editedRuntimeId);
}

let browser = null;
try {
  await requireSuccess(start("Source generation", npmCli, ["run", "generate"]));
  await requireSuccess(start("Web build", velarCli, ["build", "apps/web"]));

  const server = start("OpenVoxel server", velarCli, ["serve"], {
    cwd: join(projectRoot, "apps", "server"),
    env: {
      OPENVOXEL_DB: join(runtimeDirectory, "acceptance.sqlite"),
      OPENVOXEL_LOGGER: "false",
    },
  });
  await waitForUrl("http://127.0.0.1:3000/api/health", server);

  const preview = start("Web preview", velarCli, ["preview", "apps/web", "--port", "4173"]);
  await waitForUrl("http://127.0.0.1:4173/", preview);

  browser = await chromium.launch({ headless: true });
  const page = await browser.newPage();
  const browserFailures = [];
  page.on("pageerror", (error) => browserFailures.push(`pageerror: ${error.message}`));
  page.on("console", (message) => {
    if (message.type() === "error") browserFailures.push(`console: ${message.text()}`);
  });

  const runId = Date.now();
  const onlineWorldId = `online-${runId}`;
  const localWorldId = `local-${runId}`;
  await page.goto("http://127.0.0.1:4173/", { waitUntil: "networkidle" });

  await runConformance(page, "online", `online-contract-${runId}`);
  const onlineEditedRuntimeId = await createEditReconnect(page, onlineWorldId, "Online");

  await page.reload({ waitUntil: "networkidle" });
  await openPersisted(page, onlineWorldId, onlineEditedRuntimeId);

  await selectBackend(page, "local");
  await runConformance(page, "local", `local-contract-${runId}`);
  const localEditedRuntimeId = await createEditReconnect(page, localWorldId, "Local");

  await page.reload({ waitUntil: "networkidle" });
  await selectBackend(page, "local");
  await openPersisted(page, localWorldId, localEditedRuntimeId);
  assert.deepEqual(browserFailures, []);

  console.log(`Browser acceptance passed for OnlineBackend ${onlineWorldId} and LocalBackend ${localWorldId}`);
} finally {
  if (browser !== null) await browser.close();
  for (const processInfo of processes.reverse()) await stop(processInfo);
  await rm(runtimeDirectory, { recursive: true, force: true });
}
