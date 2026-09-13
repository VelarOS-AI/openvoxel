import assert from "node:assert/strict";
import {spawn} from "node:child_process";
import {once} from "node:events";
import {createConnection} from "node:net";
import {fileURLToPath} from "node:url";
import {readFile} from "node:fs/promises";
import test from "node:test";
import {acquireValidationSession, validationJobs} from "../validation-session.mjs";

test("validation is serial by default and parallelism must be an explicit bounded integer", () => {
  assert.equal(validationJobs(undefined), 1);
  for (const value of ["1", "2", "3", "4"]) assert.equal(validationJobs(value), Number(value));
  for (const value of ["", "0", "-1", "8", "2oops", "1.5", "NaN"]) {
    assert.throws(() => validationJobs(value), /integer from 1 to 4/u);
  }
});

test("an independent task is rejected while a nested task can share the lease", async () => {
  const env = {};
  const owner = await acquireValidationSession({port: 0, env});
  try {
    assert.equal(owner.shared, false);
    await assert.rejects(acquireValidationSession({port: owner.port, env: {}}), /slot .* is busy/u);
    const nested = await acquireValidationSession({port: owner.port, env: {...env}});
    assert.equal(nested.shared, true);
    await nested.close();
    await assert.rejects(acquireValidationSession({port: owner.port, env: {}}), /is busy/u);
    await assert.rejects(acquireValidationSession({port: owner.port, env: {
      OPENVOXEL_VALIDATION_SESSION: "not-the-owner",
    }}), /is busy/u);
  } finally { await owner.close(); }
  assert.equal(env.OPENVOXEL_VALIDATION_SESSION, undefined);
  const next = await acquireValidationSession({port: owner.port, env: {}});
  await next.close();
});

test("a stale inherited token acquires a fresh task instead of bypassing the lease", async () => {
  const env = {OPENVOXEL_VALIDATION_SESSION: "stale"};
  const session = await acquireValidationSession({port: 0, env});
  try {
    assert.equal(session.shared, false);
    assert.notEqual(env.OPENVOXEL_VALIDATION_SESSION, "stale");
  } finally { await session.close(); }
});

test("oversized requests are disconnected and cannot pin the lease", async () => {
  const session = await acquireValidationSession({port: 0, env: {}});
  try {
    const socket = createConnection({host: "127.0.0.1", port: session.port});
    socket.on("error", () => {});
    const closed = once(socket, "close");
    socket.on("connect", () => socket.write("x".repeat(129)));
    await closed;
  } finally { await session.close(); }
});

test("the OS releases a lease after its owner is terminated", async () => {
  const moduleUrl = new URL("../validation-session.mjs", import.meta.url).href;
  const child = spawn(process.execPath, ["--input-type=module", "-e", `
    import {acquireValidationSession} from ${JSON.stringify(moduleUrl)};
    const session = await acquireValidationSession({port: 0, env: {}});
    console.log(session.port);
    setInterval(() => {}, 1000);
  `], {stdio: ["ignore", "pipe", "pipe"]});
  const exited = once(child, "exit");
  try {
    const [chunk] = await once(child.stdout, "data");
    const port = Number(String(chunk).trim());
    assert.ok(port > 0);
    child.kill("SIGTERM");
    await exited;
    const next = await acquireValidationSession({port, env: {}});
    await next.close();
  } finally {
    if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
  }
});

test("the command wrapper propagates failure and admits nested npm-style commands", async () => {
  const runner = fileURLToPath(new URL("../run-validation.mjs", import.meta.url));
  for (const code of [0, 7]) {
    const child = spawn(process.execPath, [runner, "--", process.execPath, "-e", `process.exit(${code})`], {
      env: process.env, stdio: "ignore",
    });
    const [actual] = await once(child, "exit");
    assert.equal(actual, code);
  }
});

test("single-file entry points cannot accidentally discover the entire repository", async () => {
  const runner = fileURLToPath(new URL("../run-test-file.mjs", import.meta.url));
  for (const args of [["native"], ["velar"], ["native", "--watch"], ["velar", "packages/world/generation"]]) {
    const child = spawn(process.execPath, [runner, ...args], {stdio: "ignore"});
    const [code] = await once(child, "exit");
    assert.equal(code, 1);
  }
});

test("npm validation entry points share the guard and keep Node test files serial", async () => {
  const root = new URL("../../", import.meta.url);
  const lock = JSON.parse(await readFile(new URL("package-lock.json", root), "utf8"));
  const paths = Object.entries(lock.packages)
    .filter(([path, metadata]) => !path.includes("node_modules/") && (path === "" || metadata.name))
    .map(([path]) => path);
  for (const path of paths) {
    const manifest = JSON.parse(await readFile(new URL(`${path ? `${path}/` : ""}package.json`, root), "utf8"));
    for (const [name, script] of Object.entries(manifest.scripts ?? {})) {
      if (/^(test(?::|$)|validate(?::|$)|check(?::|$)|format:check(?::|$)|build(?::|$)|generate(?::|$)|benchmark(?::|$)|quality$)/u.test(name)) {
        assert.match(script, /run-validation\.mjs/u, `${path || "root"}: ${name}`);
      }
      if (script.includes("node --test ")) assert.match(script, /node --test --test-concurrency=1 /u);
    }
  }
});

test("cancelling a wrapper also cleans up a descendant that ignores SIGTERM", {
  skip: process.platform === "win32", timeout: 12000,
}, async () => {
  const runner = fileURLToPath(new URL("../run-validation.mjs", import.meta.url));
  const env = {...process.env};
  delete env.OPENVOXEL_VALIDATION_GROUP;
  const descendant = 'process.on("SIGTERM", () => {}); console.log(process.pid); setInterval(() => {}, 1000);';
  const script = `
    const {spawn} = require('node:child_process');
    spawn(process.execPath, ['-e', ${JSON.stringify(descendant)}], {stdio: 'inherit'});
    setInterval(() => {}, 1000);
  `;
  const child = spawn(process.execPath, [runner, "--", process.execPath, "-e", script], {
    env, stdio: ["ignore", "pipe", "pipe"],
  });
  const exited = once(child, "exit");
  let descendantPid;
  try {
    const [chunk] = await once(child.stdout, "data");
    descendantPid = Number(String(chunk).trim());
    assert.ok(Number.isSafeInteger(descendantPid) && descendantPid > 0);
    child.kill("SIGTERM");
    const [code] = await exited;
    assert.equal(code, 130);
    assert.throws(() => process.kill(descendantPid, 0), {code: "ESRCH"});
  } finally {
    if (child.exitCode === null && child.signalCode === null) child.kill("SIGTERM");
    if (Number.isSafeInteger(descendantPid) && descendantPid > 0) {
      try { process.kill(descendantPid, "SIGKILL"); } catch (error) { if (error.code !== "ESRCH") throw error; }
    }
  }
});
