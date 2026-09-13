import {spawn} from "node:child_process";
import {enterValidationSession} from "./validation-session.mjs";

const [mode, command, ...args] = process.argv.slice(2);
if (!["--", "--shell"].includes(mode) || !command || (mode === "--shell" && args.length)) {
  throw new Error('Usage: run-validation.mjs -- <command> [args...] | --shell "command"');
}

let session;
try {
  session = await enterValidationSession();
} catch (error) {
  process.stderr.write(`${error.message}\n`);
  process.exit(1);
}

// Nested npm scripts stay in the outer task's process group. Cancelling the
// outer wrapper reaches npm, Velar, esbuild and Chromium together.
const isolated = process.env.OPENVOXEL_VALIDATION_GROUP !== "1" && process.platform !== "win32";
const child = spawn(command, args, {
  stdio: "inherit", env: {...process.env, OPENVOXEL_VALIDATION_GROUP: "1"},
  shell: mode === "--shell", detached: isolated,
});
let cancelled = false;
let killTimer;
const stop = (signal) => {
  if (!Number.isInteger(child.pid)) return;
  try {
    if (isolated) process.kill(-child.pid, signal);
    else child.kill(signal);
  } catch (error) {
    if (error.code !== "ESRCH") throw error;
  }
};
const cancel = () => {
  if (cancelled) return;
  cancelled = true;
  stop("SIGTERM");
  killTimer = setTimeout(() => stop("SIGKILL"), 5000);
};
process.on("SIGINT", cancel);
process.on("SIGTERM", cancel);
const result = await new Promise((resolve) => {
  child.once("error", (error) => { process.stderr.write(`${error.message}\n`); resolve(1); });
  child.once("close", (code) => resolve(code ?? 1));
});
// A cancelled shell can finish before its descendants. Retain the slot until
// the bounded group cleanup has run, so another test cannot pile onto them.
if (cancelled && isolated) await new Promise((resolve) => setTimeout(resolve, 5100));
clearTimeout(killTimer);
process.removeListener("SIGINT", cancel);
process.removeListener("SIGTERM", cancel);
await session.close();
process.exitCode = cancelled ? 130 : result;
