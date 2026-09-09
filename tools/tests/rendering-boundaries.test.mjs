import assert from "node:assert/strict";
import test from "node:test";
import { inspectModule } from "@velarscript/compiler";
import {
  allowedOpenVoxelDependencies,
  gameBabylonBackendHome,
  gameMeshingWorkerSpecifier,
  gamePublicInterfaceViolations,
  gameWorkerBridgeViolations,
  packageHomes,
  publicInterfaceTypeReferences,
  renderingImportViolations,
  renderingManifestViolations,
  workerClosureViolations,
} from "../architecture/policy.mjs";

const interfaceFor = (source) => {
  const inspected = inspectModule(source, { path: "fixture.vel" });
  assert.deepEqual(inspected.diagnostics, []);
  return inspected.moduleInterface;
};

test("game is registered as the sole web graphics composition responsibility", () => {
  assert.equal(packageHomes.get("@openvoxel/game"), "packages/client/game");
  assert.deepEqual(
    [...allowedOpenVoxelDependencies.get("@openvoxel/game")].sort(),
    ["@openvoxel/client", "@openvoxel/renderer", "@openvoxel/world"],
  );
  assert.deepEqual(
    [...allowedOpenVoxelDependencies.get("@openvoxel/web")].sort(),
    ["@openvoxel/client", "@openvoxel/game", "@openvoxel/protocol", "@openvoxel/world"],
  );
});

test("only the game manifest may declare Babylon and web cannot depend on renderer", () => {
  const renderer = renderingManifestViolations({
    name: "@openvoxel/renderer",
    dependencies: { "@babylonjs/core": "9.23.0" },
    imports: { "#renderer/babylon": "./src/native/babylon.mjs" },
  });
  assert.match(renderer.join("\n"), /owned exclusively by @openvoxel\/game/);
  assert.match(renderer.join("\n"), /cannot reference Babylon/);

  const web = renderingManifestViolations({
    name: "@openvoxel/web",
    devDependencies: { "@openvoxel/renderer": "0.2.0" },
    imports: { "#engine": "@babylonjs/core/Engines/engine.js" },
  });
  assert.match(web.join("\n"), /must consume graphics through @openvoxel\/game/);
  assert.match(web.join("\n"), /cannot redirect to a Babylon package/);

  assert.deepEqual(renderingManifestViolations({
    name: "@openvoxel/game",
    dependencies: { "@babylonjs/core": "9.23.0" },
  }), []);
});

test("Babylon imports are confined to the game backend and stay concrete", () => {
  const babylonEngine = "@babylonjs/core/Engines/engine.js";
  assert.match(renderingImportViolations({
    ownerName: "@openvoxel/web",
    path: "apps/web/src/leak.mjs",
    specifier: babylonEngine,
  }).join("\n"), /game Babylon backend or its tests/);

  assert.match(renderingImportViolations({
    ownerName: "@openvoxel/renderer",
    path: "packages/client/rendering/src/mesher.vel",
    specifier: "#openvoxel/renderer/babylon-surface",
  }).join("\n"), /cannot import or alias Babylon/);

  assert.match(renderingImportViolations({
    ownerName: "@openvoxel/web",
    path: "apps/web/src/world.vel",
    specifier: "@openvoxel/renderer/meshing-worker",
  }).join("\n"), /must import @openvoxel\/game instead/);

  assert.deepEqual(renderingImportViolations({
    ownerName: "@openvoxel/game",
    path: `${gameBabylonBackendHome}/native/surface.mjs`,
    specifier: babylonEngine,
  }), []);
  assert.deepEqual(renderingImportViolations({
    ownerName: "@openvoxel/game",
    path: "packages/client/game/tests/backend.test.mjs",
    specifier: babylonEngine,
  }), []);
  assert.match(renderingImportViolations({
    ownerName: "@openvoxel/renderer",
    path: "packages/client/rendering/tests/backend.test.mjs",
    specifier: babylonEngine,
  }).join("\n"), /game Babylon backend or its tests/);
  assert.match(renderingImportViolations({
    ownerName: "@openvoxel/game",
    path: `${gameBabylonBackendHome}/native/surface.mjs`,
    specifier: "@babylonjs/core",
  }).join("\n"), /concrete responsibility modules/);
});

test("game public Velar API rejects Babylon names and unknown native handles", () => {
  const babylon = gamePublicInterfaceViolations(interfaceFor(
    'export {BabylonSurface} from "./backend.vel"',
  ));
  assert.match(babylon.join("\n"), /Babylon/);

  const unknown = gamePublicInterfaceViolations(interfaceFor([
    "export type PublicSurface:",
    "    readonly native: unknown",
  ].join("\n")));
  assert.match(unknown.join("\n"), /unknown native handle/);

  const privateHandle = gamePublicInterfaceViolations(interfaceFor([
    "type PrivateSurface:",
    "    readonly native: unknown",
    "export def ready() -> bool: true",
  ].join("\n")));
  assert.deepEqual(privateHandle, []);

  const importedType = interfaceFor([
    'import {NativeHandle} from "./backend.vel"',
    "export type PublicSurface = NativeHandle",
  ].join("\n"));
  assert.deepEqual([...publicInterfaceTypeReferences(importedType)], ["NativeHandle"]);
});

test("worker closure rejects transitive game and Babylon dependencies", () => {
  assert.match(gameWorkerBridgeViolations([
    "@openvoxel/renderer/meshing-worker",
    "./runtime/world-game.vel",
  ]).join("\n"), /must only forward/);
  assert.deepEqual(gameWorkerBridgeViolations(["@openvoxel/renderer/meshing-worker"]), []);

  const gameGraph = new Map([
    ["web-worker", { ownerName: "@openvoxel/web", edges: [
      { specifier: "@openvoxel/renderer/meshing-worker", target: "renderer-worker", resolvedOwnerName: "@openvoxel/renderer" },
    ] }],
    ["renderer-worker", { ownerName: "@openvoxel/renderer", edges: [
      { specifier: "../bridge.vel", target: "game-bridge", resolvedOwnerName: "@openvoxel/game" },
    ] }],
    ["game-bridge", { ownerName: "@openvoxel/game", edges: [] }],
  ]);
  assert.match(workerClosureViolations("web-worker", gameGraph).join("\n"), /only through @openvoxel\/game\/meshing-worker/);

  const babylonGraph = new Map([
    ["web-worker", { ownerName: "@openvoxel/web", edges: [
      { specifier: "./adapter.mjs", target: "adapter", resolvedOwnerName: "@openvoxel/web" },
    ] }],
    ["adapter", { ownerName: "@openvoxel/web", edges: [
      { specifier: "@babylonjs/core/Engines/engine.js", target: null, resolvedOwnerName: null },
    ] }],
  ]);
  assert.match(workerClosureViolations("web-worker", babylonGraph).join("\n"), /cannot import @babylonjs/);

  const pureGraph = new Map([
    ["web-worker", { ownerName: "@openvoxel/web", edges: [
      { specifier: gameMeshingWorkerSpecifier, target: "game-worker-bridge", resolvedOwnerName: "@openvoxel/game", gameWorkerBridge: true },
    ] }],
    ["game-worker-bridge", { ownerName: "@openvoxel/game", gameWorkerBridge: true, edges: [
      { specifier: "@openvoxel/renderer/meshing-worker", target: "renderer-worker", resolvedOwnerName: "@openvoxel/renderer" },
    ] }],
    ["renderer-worker", { ownerName: "@openvoxel/renderer", edges: [] }],
  ]);
  assert.deepEqual(workerClosureViolations("web-worker", pureGraph), []);

  pureGraph.get("game-worker-bridge").edges.push({
    specifier: "./runtime/world-game.vel",
    target: "game-runtime",
    resolvedOwnerName: "@openvoxel/game",
  });
  pureGraph.set("game-runtime", { ownerName: "@openvoxel/game", edges: [] });
  assert.match(workerClosureViolations("web-worker", pureGraph).join("\n"), /only through @openvoxel\/game\/meshing-worker/);
});
