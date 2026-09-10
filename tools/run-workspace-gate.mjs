import {availableParallelism} from "node:os";
import {readFile} from "node:fs/promises";
import {dirname, resolve} from "node:path";
import {fileURLToPath} from "node:url";
import {spawn} from "node:child_process";

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const packageLock = JSON.parse(await readFile(resolve(projectRoot, "package-lock.json"), "utf8"));
const gate = process.argv[2];

if (gate === undefined || gate.startsWith("-")) {
  throw new Error("Usage: node tools/run-workspace-gate.mjs <script>");
}

const workspacePackages = Object.entries(packageLock.packages)
  .filter(([path, metadata]) => path !== "" && !path.includes("node_modules/") && metadata.name !== undefined)
  .map(([path, metadata]) => ({path, name: metadata.name}))
  .sort((left, right) => left.path.localeCompare(right.path));

const runnable = [];
for (const workspace of workspacePackages) {
  const manifest = JSON.parse(await readFile(resolve(projectRoot, workspace.path, "package.json"), "utf8"));
  if (manifest.scripts?.[gate] !== undefined) runnable.push(workspace);
}

const configuredJobs = Number.parseInt(process.env.OPENVOXEL_VALIDATE_JOBS ?? "", 10);
const jobs = Number.isSafeInteger(configuredJobs) && configuredJobs > 0
  ? configuredJobs
  : Math.min(4, availableParallelism());
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
  const output = [];
  child.stdout.on("data", (chunk) => output.push(chunk));
  child.stderr.on("data", (chunk) => output.push(chunk));
  const result = await new Promise((resolveResult) => {
    child.once("error", (error) => resolveResult({error, code: null, signal: null}));
    child.once("close", (code, signal) => resolveResult({error: null, code, signal}));
  });
  process.stdout.write(Buffer.concat(output));
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
