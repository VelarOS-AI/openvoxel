import { readFile, readdir } from "node:fs/promises";
import { dirname, extname, isAbsolute, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { inspectJavaScriptModule, inspectModule } from "@velarscript/compiler";
import { velarCompilerExtension as nodeExtension } from "@velarscript/node/compiler";
import { velarCompilerExtension as webExtension } from "@velarscript/web/compiler";

const codeExtensions = new Set([".vel", ".js", ".mjs"]);
const developmentDirectories = new Set(["tests", "tools", "benchmarks"]);
const ignoredDirectories = new Set([".git", ".velar", "dist", "generated", "node_modules"]);
const portable = (path) => path.split(sep).join("/");
const ownsPath = (home, path) => {
  const local = relative(home, path);
  return local === "" || (!local.startsWith(`..${sep}`) && local !== ".." && !isAbsolute(local));
};

// Syntax and module edges belong to the installed compiler. This gate adds
// repository responsibility policy; velar check remains the resolver/type gate.
export function moduleEdges(source, path, extensions = []) {
  if (extname(path) !== ".vel") {
    return inspectJavaScriptModule(source).edges
      .filter((edge) => edge.source !== null)
      .map((edge) => ({ source: edge.source, start: edge.start, dynamic: edge.dynamic }));
  }
  const inspected = inspectModule(source, { path, extensions });
  if (inspected.diagnostics.length > 0) {
    throw new Error(inspected.diagnostics.map((item) => `${item.code}: ${item.message}`).join("; "));
  }
  return [
    ...inspected.dependencies.map((edge) => ({ source: edge.source, start: edge.span.start, dynamic: edge.dynamic })),
    ...inspected.resources.map((edge) => ({ source: edge.source, start: 0, dynamic: false })),
  ];
}

function targets(value) {
  if (typeof value === "string") return [value];
  if (Array.isArray(value)) return value.flatMap(targets);
  if (value !== null && typeof value === "object") return Object.values(value).flatMap(targets);
  return [];
}

function mappingTargets(mapping, key) {
  if (mapping === null || typeof mapping !== "object") return [];
  if (Object.hasOwn(mapping, key)) return targets(mapping[key]);
  // Public wildcard maps are declaration data, not source-code resolution.
  const patterns = Object.keys(mapping).filter((pattern) => pattern.includes("*"))
    .sort((left, right) => right.length - left.length);
  for (const pattern of patterns) {
    const [before, after] = pattern.split("*");
    if (!key.startsWith(before) || !key.endsWith(after) || key.length < before.length + after.length) continue;
    const matched = key.slice(before.length, after.length === 0 ? undefined : -after.length);
    return targets(mapping[pattern]).map((target) => target.replaceAll("*", matched));
  }
  return [];
}

export function publicEntryTargets(manifest, subpath) {
  if (subpath === "." && typeof manifest.velar?.entry === "string") return [manifest.velar.entry];
  const entries = mappingTargets(manifest.velar?.entries, subpath);
  if (entries.length > 0) return entries;
  const resource = manifest.velar?.resources?.[subpath];
  if (typeof resource?.path === "string") return [resource.path];
  const exports = manifest.exports;
  if (subpath === "." && (typeof exports === "string" || Array.isArray(exports))) return targets(exports);
  if (subpath === "." && exports !== null && typeof exports === "object"
    && !Object.keys(exports).some((key) => key.startsWith("."))) return targets(exports);
  return mappingTargets(exports, subpath);
}

function isProduction(path, owner) {
  return !portable(relative(owner.home, path)).split("/").some((part) => developmentDirectories.has(part));
}

function blockedProductionTarget(path, owner) {
  const parts = portable(relative(owner.home, path)).split("/");
  return parts.some((part) => developmentDirectories.has(part))
    || (parts.includes("generated") && codeExtensions.has(extname(path)));
}

function resolveOwner(path, packages) {
  return [...packages.values()].find((candidate) => ownsPath(candidate.home, path));
}

export function dependencyViolations({ path, owner, packages, edge }) {
  const messages = [];
  const production = isProduction(path, owner);
  const seenAliases = new Set();
  const inspectTarget = (specifier) => {
    if (specifier.startsWith("#")) {
      if (seenAliases.has(specifier)) {
        messages.push(`cyclic package import alias ${specifier}`);
        return;
      }
      seenAliases.add(specifier);
      const declared = mappingTargets(owner.manifest.imports, specifier);
      if (declared.length === 0) messages.push(`undeclared package import alias ${specifier}`);
      for (const target of declared) inspectTarget(target.startsWith(".") ? resolve(owner.home, target) : target);
      seenAliases.delete(specifier);
      return;
    }
    if (specifier.startsWith("@openvoxel/")) {
      const [scope, name, ...segments] = specifier.split("/");
      const packageName = `${scope}/${name}`;
      const dependency = packages.get(packageName);
      if (dependency === undefined) {
        messages.push(`unknown responsibility package ${packageName}`);
        return;
      }
      if (packageName !== owner.manifest.name
        && !Object.hasOwn(owner.manifest.dependencies ?? {}, packageName)
        && (production || !Object.hasOwn(owner.manifest.devDependencies ?? {}, packageName))) {
        messages.push(`${packageName} must be declared in this package's ${production ? "dependencies" : "dependencies or devDependencies"}`);
      }
      if (segments.some((segment) => segment === ".." || segment === "." || segment === "")) {
        messages.push(`invalid public package subpath ${specifier}`);
        return;
      }
      const declared = publicEntryTargets(dependency.manifest, segments.length === 0 ? "." : `./${segments.join("/")}`);
      if (declared.length === 0) messages.push(`${specifier} is not a declared public package entry`);
      for (const target of declared) {
        const targetPath = resolve(dependency.home, target);
        if (!ownsPath(dependency.home, targetPath)) messages.push(`public entry ${specifier} escapes its package`);
        if (production && blockedProductionTarget(targetPath, dependency)) {
          messages.push(`production source cannot import development or generated code through ${specifier}`);
        }
      }
      return;
    }
    if (specifier.startsWith(".") || isAbsolute(specifier) || specifier.startsWith("file:")) {
      const targetPath = specifier.startsWith("file:")
        ? fileURLToPath(specifier)
        : resolve(dirname(path), specifier.split(/[?#]/u)[0]);
      const targetOwner = resolveOwner(targetPath, packages);
      if (targetOwner?.home !== owner.home || !ownsPath(owner.home, targetPath)) {
        messages.push(`relative or absolute import ${specifier} crosses a package boundary; use its public package entry`);
      } else if (production && blockedProductionTarget(targetPath, owner)) {
        messages.push(`production source cannot import development or generated code ${specifier}`);
      }
    }
  };
  inspectTarget(edge.source);
  return messages;
}

async function sources(home) {
  const paths = [];
  for (const entry of await readdir(home, { withFileTypes: true })) {
    const path = resolve(home, entry.name);
    if (entry.isDirectory() && !ignoredDirectories.has(entry.name)) paths.push(...await sources(path));
    else if (entry.isFile() && codeExtensions.has(extname(path))) paths.push(path);
  }
  return paths;
}

export async function inspectSourceBoundaries(projectRoot, registeredPackages) {
  const packages = new Map([...registeredPackages].map(([name, value]) => [name, {
    ...value,
    home: resolve(projectRoot, dirname(value.owner)),
  }]));
  const violations = [];
  for (const owner of packages.values()) {
    const manifest = JSON.parse(await readFile(resolve(owner.home, "velar.json"), "utf8"));
    const extensions = [];
    if (manifest.extensions?.some((name) => name === "@velarscript/web" || name === "@velarscript/desktop")) extensions.push(webExtension);
    if (manifest.extensions?.some((name) => name === "@velarscript/node" || name === "@velarscript/server" || name === "@velarscript/desktop")) extensions.push(nodeExtension);
    for (const path of await sources(owner.home)) {
      const source = await readFile(path, "utf8");
      const label = portable(relative(projectRoot, path));
      try {
        for (const edge of moduleEdges(source, path, extensions)) {
          const line = source.slice(0, edge.start).split("\n").length;
          violations.push(...dependencyViolations({ path, owner, packages, edge }).map((message) => `${label}:${line}: ${message}`));
        }
      } catch (error) {
        violations.push(`${label}: compiler module inspection failed: ${error.message}`);
      }
    }
  }
  return violations;
}
