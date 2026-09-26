import assert from "node:assert/strict";
import {readFile} from "node:fs/promises";
import {dirname, join, relative, resolve} from "node:path";
import test from "node:test";
import {fileURLToPath} from "node:url";

const packageRoot = fileURLToPath(new URL("../", import.meta.url));
const projectRoot = resolve(packageRoot, "../../..");
const gameRoot = join(projectRoot, "packages/client/game");
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

test("renderer exposes pure meshing and the game package owns its host bridge", async () => {
  const manifest = JSON.parse(await readFile(join(packageRoot, "package.json"), "utf8"));
  assert.equal(manifest.velar.entry, "src/index.vel");
  assert.deepEqual(manifest.velar.entries, {"./meshing-worker": workerEntry, "./lighting-worker": "src/lighting-worker.vel"});
  assert.equal(manifest.exports["./meshing-worker"], "./dist/meshing-worker.js");

  const rootEntry = await readFile(join(packageRoot, manifest.velar.entry), "utf8");
  assert.doesNotMatch(rootEntry, /serveMeshingWorker|meshing-worker\.vel/u);

  const gameManifest = JSON.parse(await readFile(join(gameRoot, "package.json"), "utf8"));
  assert.equal(gameManifest.velar.entries["./meshing-worker"], "src/meshing-worker.vel");
  assert.equal(gameManifest.exports["./meshing-worker"], "./dist/meshing-worker.js");
  const gameBridge = await readFile(join(gameRoot, "src/meshing-worker.vel"), "utf8");
  assert.match(gameBridge, /from "@openvoxel\/renderer\/meshing-worker"/u);
  assert.doesNotMatch(gameBridge, /runtime\/|graphics\/|backends\/|@babylonjs/u);

  const webBootstrap = await readFile(join(projectRoot, "apps/web/src/meshing-worker.vel"), "utf8");
  assert.match(webBootstrap, /from "@openvoxel\/game\/meshing-worker"/u);
  assert.doesNotMatch(webBootstrap, /from "@openvoxel\/renderer/u);
});

test("lighting Worker stays in the CPU renderer closure behind the game bridge", async () => {
  const closure = await sourceClosure("src/lighting-worker.vel");
  const source = [...closure.values()].join("\n");
  assert.doesNotMatch(source, /@babylonjs|resource-pack-data|builtinClientResourcePack|openWorldGraphics/u);
  assert.match(source, /createClientLightField/u);
  const game = await readFile(join(gameRoot, "src/lighting-worker.vel"), "utf8");
  assert.match(game, /from "@openvoxel\/renderer\/lighting-worker"/u);
  assert.doesNotMatch(game, /runtime\/|graphics\/|backends\/|@babylonjs/u);
  const web = await readFile(join(projectRoot, "apps/web/src/lighting-worker.vel"), "utf8");
  assert.match(web, /from "@openvoxel\/game\/lighting-worker"/u);
});

test("meshing Worker source closure excludes GPU and generated resource owners", async () => {
  const closure = await sourceClosure(workerEntry);
  const paths = [...closure.keys()].map((path) => relative(packageRoot, path).split("\\").join("/"));
  assert.ok(paths.includes(workerEntry));
  assert.ok(paths.includes("src/mesher.vel"));
  for (const responsibility of ["catalog", "portals", "batch", "faces", "models"]) {
    assert.ok(paths.includes(`src/meshing/${responsibility}.vel`));
  }
  assert.equal(paths.includes("src/index.vel"), false);
  assert.equal(paths.includes("src/builtin-resource-pack.vel"), false);

  const source = [...closure.values()].join("\n");
  for (const forbidden of [
    "@babylonjs/core",
    "PBRMaterial",
    "openWorldGraphics",
    "resource-pack-data",
    "builtinClientResourcePack",
    "data:image/",
  ]) {
    assert.equal(source.includes(forbidden), false, `Worker closure must exclude ${forbidden}`);
  }
});
