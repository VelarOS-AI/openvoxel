import {readFile} from "node:fs/promises";
import {dirname, resolve} from "node:path";
import {fileURLToPath} from "node:url";
import {spawn} from "node:child_process";
import {enterValidationSession, validationJobs} from "./validation-session.mjs";

await enterValidationSession();

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const packageLock = JSON.parse(await readFile(resolve(projectRoot, "package-lock.json"), "utf8"));
const gate = process.argv[2];

if (gate === undefined || gate.startsWith("-")) {
  throw new Error("Usage: node tools/run-workspace-gate.mjs <script> [workspace-name...]");
}

const workspacePackages = Object.entries(packageLock.packages)
  .filter(([path, metadata]) => path !== "" && !path.includes("node_modules/") && metadata.name !== undefined)
  .map(([path, metadata]) => ({path, name: metadata.name}))
  .sort((left, right) => left.path.localeCompare(right.path));

const runnable = [];
const selected = new Set(process.argv.slice(3));
for (const name of selected) {
  if (!workspacePackages.some((workspace) => workspace.name === name)) throw new Error(`Unknown workspace: ${name}`);
}
for (const workspace of workspacePackages) {
  if (selected.size > 0 && !selected.has(workspace.name)) continue;
  const manifest = JSON.parse(await readFile(resolve(projectRoot, workspace.path, "package.json"), "utf8"));
  if (manifest.scripts?.[gate] !== undefined) runnable.push(workspace);
  else if (selected.has(workspace.name)) throw new Error(`${workspace.name} has no ${gate} script`);
}
if (runnable.length === 0) throw new Error(`No workspace has a ${gate} script`);

const jobs = validationJobs(process.env.OPENVOXEL_VALIDATE_JOBS);
const npmCommand = process.platform === "win32" ? "npm.cmd" : "npm";
const activeJobs = Math.min(jobs, runnable.length);
let cursor = 0;
let failed = false;

async function runWorkspace(workspace) {
  const child = spawn(
    npmCommand,
    ["run", gate, "--workspace", workspace.name, "--ignore-scripts"],
    {cwd: projectRoot, env: process.env, stdio: ["ignore", "pipe", "pipe"]},
  );
  process.stdout.write(`[${workspace.name}] ${gate}\n`);
  child.stdout.pipe(process.stdout);
  child.stderr.pipe(process.stderr);
  const result = await new Promise((resolveResult) => {
    child.once("error", (error) => resolveResult({error, code: null, signal: null}));
    child.once("close", (code, signal) => resolveResult({error: null, code, signal}));
  });
  if (result.error !== null) {
    process.stderr.write(`${workspace.name} ${gate} could not start: ${result.error.message}\n`);
    return false;
  }
  if (result.code !== 0 || result.signal !== null) {
    process.stderr.write(`${workspace.name} ${gate} failed${result.signal === null ? ` with code ${result.code}` : ` after signal ${result.signal}`}\n`);
    return false;
  }
  return true;
}

async function worker() {
  while (!failed) {
    const index = cursor;
    cursor += 1;
    if (index >= runnable.length) return;
    if (!await runWorkspace(runnable[index])) failed = true;
  }
}

await Promise.all(Array.from({length: activeJobs}, () => worker()));
if (failed) process.exitCode = 1;
else process.stdout.write(`${gate} passed in ${runnable.length} workspaces with ${activeJobs} jobs\n`);
