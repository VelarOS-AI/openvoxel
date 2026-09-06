import assert from "node:assert/strict";
import {readFile} from "node:fs/promises";
import {dirname, join, relative, resolve} from "node:path";
import test from "node:test";
import {fileURLToPath} from "node:url";

const packageRoot = fileURLToPath(new URL("../", import.meta.url));
const projectRoot = resolve(packageRoot, "../../..");
const sourceRoot = join(packageRoot, "src");
const workerEntry = "src/meshing-worker.vel";

function relativeVelarImports(source) {
  return [...source.matchAll(/(?:from\s+|import\s+)["'](\.\.?\/[^"']+\.vel)["']/gu)]
    .map((match) => match[1]);
}

async function sourceClosure(entry) {
  const pending = [resolve(packageRoot, entry)];
  const visited = new Map();
  while (pending.length > 0) {
    const path = pending.pop();
    if (visited.has(path)) continue;
    const source = await readFile(path, "utf8");
    visited.set(path, source);
    for (const specifier of relativeVelarImports(source)) {
      const dependency = resolve(dirname(path), specifier);
      assert.ok(dependency.startsWith(`${sourceRoot}/`), `${specifier} must remain inside renderer sources`);
      pending.push(dependency);
    }
  }
  return visited;
}

test("renderer exposes meshing as an exact package entry", async () => {
  const manifest = JSON.parse(await readFile(join(packageRoot, "package.json"), "utf8"));
  assert.equal(manifest.velar.entry, "src/index.vel");
  assert.deepEqual(manifest.velar.entries, {"./meshing-worker": workerEntry});
  assert.equal(manifest.exports["./meshing-worker"], "./dist/meshing-worker.js");

  const rootEntry = await readFile(join(packageRoot, manifest.velar.entry), "utf8");
  assert.doesNotMatch(rootEntry, /serveMeshingWorker|meshing-worker\.vel/u);

  const webBootstrap = await readFile(join(projectRoot, "apps/web/src/meshing-worker.vel"), "utf8");
  assert.match(webBootstrap, /from "@openvoxel\/renderer\/meshing-worker"/u);
  assert.doesNotMatch(webBootstrap, /from "@openvoxel\/renderer"/u);
});

test("meshing Worker source closure excludes GPU and generated resource owners", async () => {
  const closure = await sourceClosure(workerEntry);
  const paths = [...closure.keys()].map((path) => relative(packageRoot, path).split("\\").join("/"));
  assert.ok(paths.includes(workerEntry));
  assert.ok(paths.includes("src/mesher.vel"));
  assert.equal(paths.includes("src/index.vel"), false);
  assert.equal(paths.includes("src/surface.vel"), false);
  assert.equal(paths.includes("src/builtin-resource-pack.vel"), false);

  const source = [...closure.values()].join("\n");
  for (const forbidden of [
    "@babylonjs/core",
    "PBRMaterial",
    "openVoxelRenderSurface",
    "resource-pack-data",
    "builtinClientResourcePack",
    "data:image/",
  ]) {
    assert.equal(source.includes(forbidden), false, `Worker closure must exclude ${forbidden}`);
  }
});
