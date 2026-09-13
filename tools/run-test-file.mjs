import {spawn} from "node:child_process";
import {stat} from "node:fs/promises";
import {fileURLToPath} from "node:url";
import {enterValidationSession} from "./validation-session.mjs";

const [kind, ...files] = process.argv.slice(2);
const extension = kind === "native" ? ".test.mjs" : ".test.vel";
if (!["native", "velar"].includes(kind) || !files.length || (kind === "velar" && files.length !== 1)) {
  throw new Error("Pass explicit test files: test:native -- <file.test.mjs...> or test:file -- <file.test.vel>");
}
for (const file of files) {
  if (file.startsWith("-") || !file.endsWith(extension) || !(await stat(file)).isFile()) {
    throw new Error(`Expected an explicit ${extension} file: ${file}`);
  }
}
await enterValidationSession();
const args = kind === "native"
  ? ["--test", "--test-concurrency=1", ...files]
  : [fileURLToPath(new URL("../node_modules/@velarscript/cli/dist/cli.js", import.meta.url)), "test", ...files];
const child = spawn(process.execPath, args, {stdio: "inherit", env: process.env});
child.once("error", (error) => { process.stderr.write(`${error.message}\n`); process.exitCode = 1; });
child.once("close", (code) => { process.exitCode = code ?? 1; });
