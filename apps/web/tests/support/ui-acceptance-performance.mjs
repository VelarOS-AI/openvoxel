import assert from "node:assert/strict";
import {readFile} from "node:fs/promises";
import {dirname, relative, resolve, sep} from "node:path";
import {gzipSync} from "node:zlib";
import {builtManifestPath, webDistDirectory} from "./ui-acceptance-paths.mjs";

const initialJavaScriptBudget = {raw: 1024 * 1024, gzip: 230 * 1024};
const secondaryRouteJavaScriptBudget = {raw: 900 * 1024, gzip: 200 * 1024};
const worldJavaScriptBudget = {raw: 5 * 1024 * 1024, gzip: 1330 * 1024};
const texturePayloadBudget = {raw: 4 * 1024 * 1024, gzip: 800 * 1024};

function staticImportSpecifiers(source, owner) {
  const specifiers = [];
  let cursor = 0;
  while (cursor < source.length) {
    while (/\s/u.test(source[cursor] ?? "")) cursor += 1;
    if (!source.startsWith("import", cursor)) break;
    const afterKeyword = cursor + "import".length;
    if (/[A-Za-z0-9_$]/u.test(source[afterKeyword] ?? "")) break;
    let expressionStart = afterKeyword;
    while (/\s/u.test(source[expressionStart] ?? "")) expressionStart += 1;
    if (source[expressionStart] === "(") break;
    const statementEnd = source.indexOf(";", expressionStart);
    assert.notEqual(statementEnd, -1, `${owner} contains an unterminated static import`);
    const statement = source.slice(cursor, statementEnd);
    const quoted = [...statement.matchAll(/["']([^"']+)["']/gu)];
    assert.ok(quoted.length > 0, `${owner} contains a static import with no module specifier`);
    specifiers.push(quoted.at(-1)[1]);
    cursor = statementEnd + 1;
  }
  return specifiers;
}

async function staticJavaScriptClosure(entryPath) {
  const pending = [resolve(webDistDirectory, entryPath)];
  const visited = new Set();
  while (pending.length > 0) {
    const current = pending.pop();
    if (visited.has(current)) continue;
    visited.add(current);
    const projectPath = relative(webDistDirectory, current);
    assert.ok(projectPath !== ".." && !projectPath.startsWith(`..${sep}`), `${entryPath} imports outside the Web build`);
    assert.ok(current.endsWith(".js"), `${entryPath} statically imports a non-JavaScript module: ${projectPath}`);
    const source = await readFile(current, "utf8");
    for (const specifier of staticImportSpecifiers(source, projectPath)) {
      assert.ok(specifier.startsWith("./"), `${projectPath} retains an external production import: ${specifier}`);
      pending.push(resolve(dirname(current), specifier));
    }
  }
  return visited;
}

async function assertJavaScriptPerformance(label, paths, budget) {
  let rawBytes = 0;
  let gzipBytes = 0;
  for (const path of paths) {
    const bytes = await readFile(path);
    rawBytes += bytes.byteLength;
    gzipBytes += gzipSync(bytes, {level: 9}).byteLength;
  }
  assert.ok(rawBytes <= budget.raw, `${label} JavaScript closure exceeds its raw budget: ${rawBytes} > ${budget.raw}`);
  assert.ok(gzipBytes <= budget.gzip, `${label} JavaScript closure exceeds its gzip budget: ${gzipBytes} > ${budget.gzip}`);
}

function requireRouteAsset(manifest, routeName) {
  const pattern = new RegExp(`^assets/chunk-${routeName}-[A-Z0-9]+\\.js$`, "u");
  const assets = manifest.assets.filter((asset) => asset.role === "asset" && pattern.test(asset.path));
  assert.equal(assets.length, 1, `${routeName} must remain one lazy production entry chunk`);
  return assets[0].path;
}

export async function assertBuildPerformance() {
  const manifest = JSON.parse(await readFile(builtManifestPath, "utf8"));
  assert.match(manifest.entry, /^assets\/main-[A-Z0-9]+\.js$/u, "Web build has no content-hashed application entry");
  const initial = await staticJavaScriptClosure(manifest.entry);
  await assertJavaScriptPerformance("Initial", initial, initialJavaScriptBudget);
  const textureEntry = resolve(webDistDirectory, requireRouteAsset(manifest, "builtin-resource-pack"));
  assert.equal(initial.has(textureEntry), false, "Home must not eagerly load texture arrays");
  for (const [label, routeName, budget] of [
    ["Create world", "create-world-page", secondaryRouteJavaScriptBudget],
    ["Open world", "open-world-page", secondaryRouteJavaScriptBudget],
    ["World", "world-page", worldJavaScriptBudget],
  ]) {
    const route = await staticJavaScriptClosure(requireRouteAsset(manifest, routeName));
    assert.equal(route.has(textureEntry), false, `${label} must keep generated texture data in its independent payload`);
    for (const initialPath of initial) route.delete(initialPath);
    await assertJavaScriptPerformance(label, route, budget);
  }
  // Texture bytes are a separately bounded asset payload, not unbudgeted lazy code.
  await assertJavaScriptPerformance("Texture payload", new Set([textureEntry]), texturePayloadBudget);
}
