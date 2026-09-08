import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { velarCompilerExtension as webExtension } from "@velarscript/web/compiler";
import { velarCompilerExtension as nodeExtension } from "@velarscript/node/compiler";
import { dependencyViolations, inspectSourceBoundaries, moduleEdges, publicEntryTargets } from "../architecture/module-boundaries.mjs";

const world = {
  home: "/project/packages/world/model",
  manifest: { name: "@openvoxel/world", velar: { entry: "src/index.vel" } },
};
const blocks = {
  home: "/project/packages/content/blocks",
  manifest: {
    name: "@openvoxel/blocks",
    velar: {
      entry: "src/index.vel",
      entries: { "./worker": "src/worker.vel" },
      resources: { "./catalog-data": { path: "generated/catalog.json", type: "json" } },
    },
    exports: { ".": "./dist/index.js", "./debug": "./tests/debug.mjs", "./compiled": "./generated/compiled.mjs" },
  },
};
const client = {
  home: "/project/packages/client/access",
  manifest: {
    name: "@openvoxel/client",
    dependencies: { "@openvoxel/world": "0.2.0" },
    devDependencies: { "@openvoxel/blocks": "0.2.0" },
    imports: { "#adapter": "./src/native/adapter.mjs", "#test": "./tests/helper.mjs" },
    velar: { entry: "src/index.vel" },
  },
};
const packages = new Map([world, blocks, client].map((owner) => [owner.manifest.name, owner]));
const violations = (source, localPath = "src/main.vel", owner = client) => dependencyViolations({
  path: `${owner.home}/${localPath}`, owner, packages, edge: { source },
});

test("compiler metadata finds multiline imports, re-exports and literal dynamic imports", () => {
  const source = [
    "import {",
    "    Coordinate3,",
    '} from "@openvoxel/world"',
    'export {Other} from "@openvoxel/blocks"',
    'const load = () => import("./lazy.vel")',
  ].join("\n");
  assert.deepEqual(moduleEdges(source, "fixture.vel").map((edge) => edge.source), ["@openvoxel/world", "@openvoxel/blocks", "./lazy.vel"]);
  assert.equal(moduleEdges(source, "fixture.vel")[2].dynamic, true);
});

test("compiler metadata excludes comments, strings and regular expressions in JavaScript", () => {
  const source = String.raw`
    // import bad from "@openvoxel/bad"
    /* export * from "@openvoxel/hidden" */
    const text = 'import("@openvoxel/string")';
    const expression = /import\("@openvoxel\/regex"\)/;
    const template = \`export * from "@openvoxel/template"\`;
    import {value} from "@openvoxel/world";
    export {other} from "./other.mjs";
    const load = () => import("./lazy.mjs");
  `.replaceAll("\\`", "`");
  assert.deepEqual(moduleEdges(source, "fixture.mjs").map((edge) => edge.source), ["@openvoxel/world", "./other.mjs", "./lazy.mjs"]);
});

test("Velar comments and layout strings do not create imports", () => {
  const source = [
    '// import {Bad} from "@openvoxel/comment"',
    'const text = "',
    '    import {Bad} from "@openvoxel/layout"',
    '    export {Bad} from "@openvoxel/layout"',
    '"',
    'import {Coordinate3} from "@openvoxel/world"',
  ].join("\n");
  assert.deepEqual(moduleEdges(source, "fixture.vel").map((edge) => edge.source), ["@openvoxel/world"]);
});

test("owner extensions inspect web resources, checked JS adapters and server routes", () => {
  const webSource = 'import css unsafe "./theme.css" before look\nextern module "#adapter":\n    export def value() -> string\nimport js {value} from "#adapter"';
  assert.deepEqual(moduleEdges(webSource, "web.vel", [webExtension]).map((edge) => edge.source), ["#adapter", "./theme.css"]);
  const nodeSource = 'import {input} from "velar/serve"\nexport server routes:\n    @get(p"/health") => {ok: true}';
  assert.deepEqual(moduleEdges(nodeSource, "server.vel", [nodeExtension]).map((edge) => edge.source), ["velar/serve"]);
});

test("malformed modules fail closed instead of producing partial boundary evidence", () => {
  assert.throws(() => moduleEdges('import {', "fixture.vel"));
  assert.throws(() => moduleEdges('import {', "fixture.mjs"));
});

test("computed JavaScript imports remain the compiler resolver's responsibility", () => {
  assert.deepEqual(moduleEdges("const load = name => import(name);", "fixture.mjs"), []);
});

test("production imports require direct runtime dependencies", () => {
  assert.deepEqual(violations("@openvoxel/world"), []);
  assert.match(violations("@openvoxel/blocks")[0], /declared.*dependencies/);
});

test("test, tool and benchmark imports may use declared development dependencies", () => {
  for (const directory of ["tests", "tools", "benchmarks"]) {
    assert.deepEqual(violations("@openvoxel/blocks", `${directory}/fixture.vel`), []);
  }
  const undeclared = { ...client, manifest: { ...client.manifest, devDependencies: {} } };
  assert.match(violations("@openvoxel/blocks", "tests/fixture.vel", undeclared)[0], /declared/);
});

test("same package public imports do not require a self dependency", () => {
  assert.deepEqual(violations("@openvoxel/client"), []);
  assert.deepEqual(violations("@openvoxel/blocks/catalog-data", "src/main.vel", blocks), []);
});

test("package-internal deep imports are rejected even with a dependency", () => {
  assert.match(violations("@openvoxel/world/src/private.vel")[0], /not a declared public/);
  assert.match(violations("@openvoxel/world/../model/src/private.vel")[0], /invalid public/);
  assert.match(violations("@openvoxel/missing")[0], /unknown responsibility/);
});

test("published worker and resource entries are valid while development exports stay private to production", () => {
  const runtimeClient = { ...client, manifest: { ...client.manifest, dependencies: { "@openvoxel/blocks": "0.2.0" } } };
  assert.deepEqual(violations("@openvoxel/blocks/worker", "src/main.vel", runtimeClient), []);
  assert.deepEqual(violations("@openvoxel/blocks/catalog-data", "src/main.vel", runtimeClient), []);
  assert.match(violations("@openvoxel/blocks/debug", "src/main.vel", runtimeClient)[0], /production source/);
  assert.match(violations("@openvoxel/blocks/compiled", "src/main.vel", runtimeClient)[0], /production source/);
});

test("relative package traversal is rejected for production and test code", () => {
  assert.match(violations("../../../world/model/src/index.vel")[0], /crosses a package boundary/);
  assert.match(violations("../../../world/model/src/index.vel", "tests/fixture.vel")[0], /crosses a package boundary/);
  assert.deepEqual(violations("../src/internal.vel", "tests/fixture.vel"), []);
});

test("production cannot import local development code or generated modules", () => {
  for (const source of ["../tests/helper.vel", "../tools/generate.mjs", "../benchmarks/run.vel", "../generated/result.mjs", "../generated/result.vel"]) {
    assert.match(violations(source)[0], /production source/);
  }
  assert.deepEqual(violations("../generated/result.json"), []);
  assert.deepEqual(violations("../data/definition.json"), []);
});

test("private package aliases must be declared and obey their target's boundary", () => {
  assert.deepEqual(violations("#adapter"), []);
  assert.match(violations("#missing")[0], /undeclared package import alias/);
  assert.match(violations("#test")[0], /production source/);
  const cyclic = { ...client, manifest: { ...client.manifest, imports: { "#a": "#b", "#b": "#a" } } };
  assert.match(violations("#a", "src/main.vel", cyclic)[0], /cyclic/);
});

test("ESM URL suffixes and file URLs preserve responsibility checks", () => {
  assert.match(violations("../generated/result.mjs?fresh#module")[0], /production source/);
  assert.match(violations("file:///project/packages/world/model/src/index.vel")[0], /crosses a package boundary/);
  assert.deepEqual(violations("./native/adapter.mjs?fresh"), []);
});

test("public entry metadata supports conditional exports and explicit wildcard exclusions", () => {
  const manifest = { exports: { ".": { import: "./dist/index.mjs" }, "./features/*": "./src/features/*.mjs", "./features/internal": null } };
  assert.deepEqual(publicEntryTargets(manifest, "."), ["./dist/index.mjs"]);
  assert.deepEqual(publicEntryTargets(manifest, "./features/tree"), ["./src/features/tree.mjs"]);
  assert.deepEqual(publicEntryTargets(manifest, "./features/internal"), []);
});

test("source-tree inspection reports the importing module and source line", async () => {
  const root = await mkdtemp(join(tmpdir(), "openvoxel-boundaries-"));
  try {
    const home = join(root, "packages/fixture");
    await mkdir(join(home, "src"), { recursive: true });
    await writeFile(join(home, "velar.json"), JSON.stringify({ extensions: [] }));
    await writeFile(join(home, "src/main.vel"), '// fixture\nimport {privateValue} from "../tests/private.vel"\n');
    const registered = new Map([["@openvoxel/fixture", {
      owner: "packages/fixture/package.json",
      manifest: { name: "@openvoxel/fixture", velar: { entry: "src/main.vel" } },
    }]]);
    const found = await inspectSourceBoundaries(root, registered);
    assert.equal(found.length, 1);
    assert.match(found[0], /^packages\/fixture\/src\/main.vel:2: production source/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
