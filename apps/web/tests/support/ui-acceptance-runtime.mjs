import assert from "node:assert/strict";
import {createServer} from "node:net";
import {spawn} from "node:child_process";
import {projectRoot, velarCli} from "./ui-acceptance-paths.mjs";

export const processes = [];
const previewReadyTimeoutMs = 30_000;
const fetchTimeoutMs = 2_000;
const gracefulStopTimeoutMs = 5_000;
const forcedStopTimeoutMs = 5_000;
const serverCloseTimeoutMs = 5_000;

function errorText(error) {
  return error instanceof Error ? `${error.name}: ${error.message}` : String(error);
}

export async function graphicsBackend(browser) {
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

export async function boundedOperation(label, timeoutMs, operation) {
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

export async function attemptCleanup(failures, label, operation) {
  try {
    await operation();
  } catch (error) {
    failures.push(new Error(`${label}: ${errorText(error)}`, {cause: error}));
  }
}

export function reportCleanupFailures(scope, failures) {
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

export async function availablePort() {
  for (const port of [7273, 7274, 7275]) {
    if (await portIsAvailable(port)) return port;
  }
  throw new Error("Web UI acceptance requires an available preview port (7273, 7274, or 7275)");
}

export function start(name, args) {
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

export async function requireSuccess(processInfo, timeoutMs) {
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

export async function waitForUrl(url, processInfo, expectedHtml) {
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

export async function stop(processInfo) {
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
