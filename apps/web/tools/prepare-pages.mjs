import assert from "node:assert/strict";
import {cp, mkdir, readFile, readdir, rm, stat, writeFile} from "node:fs/promises";
import {basename, dirname, join, relative, resolve} from "node:path";
import {fileURLToPath} from "node:url";

const webRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const buildRoot = join(webRoot, "dist");
const uploadRoot = join(webRoot, "generated", "pages-upload");
const omittedFiles = new Set(["404.html", "velar-build.json", "velar-deploy.json"]);
const maximumFiles = 20_000;
const maximumFileBytes = 25 * 1024 * 1024;

function pagesHeaders(deployment) {
  const sections = new Map();
  for (const {path, values} of deployment.headers) {
    if (omittedFiles.has(path.slice(1))) continue;
    const headers = sections.get(path) ?? new Map();
    for (const [name, value] of Object.entries(values)) {
      // Pages combines matching header rules. A global no-cache would also
      // attach to fingerprinted assets and cancel their immutable lifetime.
      if (path === "/*" && name.toLowerCase() === "cache-control") continue;
      assert.match(name, /^[A-Za-z0-9-]+$/u);
      assert.ok(!/[\r\n]/u.test(value), `Invalid Pages header ${name}`);
      headers.set(name, value);
    }
    sections.set(path, headers);
  }
  return [...sections].flatMap(([path, headers]) => [path, ...[...headers].map(([name, value]) => `  ${name}: ${value}`)]).join("\n") + "\n";
}

async function listedFiles(directory, prefix = "") {
  const files = [];
  for (const entry of await readdir(directory, {withFileTypes: true})) {
    const name = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (entry.isDirectory()) files.push(...await listedFiles(join(directory, entry.name), name));
    else {
      assert.ok(entry.isFile(), `Pages asset is not a regular file: ${name}`);
      files.push(name);
    }
  }
  return files;
}

const deployment = JSON.parse(await readFile(join(buildRoot, "velar-deploy.json"), "utf8"));
assert.equal(deployment.kind, "velar-static-deployment");
assert.equal(deployment.base, "/");
assert.deepEqual(deployment.spaFallback, {source: "index.html", fallback: "404.html"});
assert.ok(Array.isArray(deployment.headers));

await rm(uploadRoot, {recursive: true, force: true});
await mkdir(uploadRoot, {recursive: true});
await cp(buildRoot, uploadRoot, {
  recursive: true,
  filter: source => {
    const name = relative(buildRoot, source);
    return !name.endsWith(".map") && !omittedFiles.has(name) && basename(source) !== ".DS_Store";
  },
});
await writeFile(join(uploadRoot, "_headers"), pagesHeaders(deployment));

const files = await listedFiles(uploadRoot);
assert.ok(files.length <= maximumFiles, `Pages asset count exceeds ${maximumFiles}`);
for (const required of ["index.html", "_headers", "local-worker.js", "meshing-worker.js", "lighting-worker.js", "generated/webgpu/glslang.wasm", "generated/webgpu/twgsl.wasm"]) {
  assert.ok(files.includes(required), `Pages asset missing: ${required}`);
}
assert.ok(!files.includes("404.html"), "A top-level 404.html disables Cloudflare Pages SPA fallback");
let totalBytes = 0;
let largest = {path: "", bytes: 0};
for (const name of files) {
  const {size} = await stat(join(uploadRoot, name));
  assert.ok(size <= maximumFileBytes, `Pages asset exceeds 25 MiB: ${name}`);
  totalBytes += size;
  if (size > largest.bytes) largest = {path: name, bytes: size};
}
const html = await readFile(join(uploadRoot, "index.html"), "utf8");
for (const [, path] of html.matchAll(/\b(?:src|href)="(\/[^"]+)"/gu)) {
  assert.ok(files.includes(path.slice(1)), `Pages entry references a missing asset: ${path}`);
}
console.log(JSON.stringify({uploadRoot, files: files.length, totalBytes, largest}));
