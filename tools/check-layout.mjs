import { readFile, readdir } from "node:fs/promises";
import { join, relative, sep } from "node:path";

const projectRoot = new URL("../", import.meta.url).pathname;
const ignoredDirectories = new Set([".git", ".velar", "dist", "node_modules"]);
const npmToolchainPackages = new Set([
  "@velarscript/cli",
  "@velarscript/compiler",
  "@velarscript/core",
  "@velarscript/desktop",
  "@velarscript/node",
  "@velarscript/server",
  "@velarscript/web",
]);
const labsScope = "@velarscript-labs/";
const labsRegistryPrefix = "https://registry.npmjs.org/@velarscript-labs/";
const allowedOpenVoxelDependencies = new Map([
  ["@openvoxel/identities", new Set()],
  ["@openvoxel/blocks", new Set(["@openvoxel/identities"])],
  ["@openvoxel/world", new Set(["@openvoxel/blocks", "@openvoxel/identities"])],
  ["@openvoxel/world-generation", new Set(["@openvoxel/blocks", "@openvoxel/identities", "@openvoxel/world"])],
  ["@openvoxel/content", new Set(["@openvoxel/blocks", "@openvoxel/identities", "@openvoxel/world", "@openvoxel/world-generation"])],
  ["@openvoxel/protocol", new Set(["@openvoxel/blocks", "@openvoxel/world"])],
  ["@openvoxel/client", new Set(["@openvoxel/protocol", "@openvoxel/world"])],
  ["@openvoxel/client-web", new Set(["@openvoxel/client", "@openvoxel/protocol", "@openvoxel/world"])],
  ["@openvoxel/world-runtime", new Set(["@openvoxel/blocks", "@openvoxel/content", "@openvoxel/identities", "@openvoxel/world", "@openvoxel/world-generation"])],
  ["@openvoxel/server", new Set(["@openvoxel/blocks", "@openvoxel/content", "@openvoxel/identities", "@openvoxel/protocol", "@openvoxel/world", "@openvoxel/world-generation", "@openvoxel/world-runtime"])],
]);
const violations = [];

function inspectDependencyFields(owner, manifest) {
  for (const field of ["dependencies", "devDependencies", "optionalDependencies", "peerDependencies"]) {
    for (const [name, specification] of Object.entries(manifest[field] ?? {})) {
      if (name.startsWith("@velarscript/") && !npmToolchainPackages.has(name)) {
        violations.push(`${owner}: ${name} cannot use the standard/toolchain @velarscript scope`);
      }
      if (name.startsWith(labsScope)
        && (typeof specification !== "string" || !/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/u.test(specification))) {
        violations.push(`${owner}: Labs package ${name} must pin an exact npm registry version`);
      }
    }
  }
}

function inspectOpenVoxelBoundary(owner, manifest) {
  const allowed = allowedOpenVoxelDependencies.get(manifest.name);
  if (allowed === undefined) return;
  for (const name of Object.keys(manifest.dependencies ?? {})) {
    if (name.startsWith("@openvoxel/") && !allowed.has(name)) {
      violations.push(`${owner}: ${manifest.name} cannot depend on ${name}`);
    }
  }
}

async function inspect(directory) {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    if (entry.isDirectory() && ignoredDirectories.has(entry.name)) continue;
    const path = join(directory, entry.name);
    if (entry.isDirectory()) {
      await inspect(path);
      continue;
    }
    if (!entry.isFile()) continue;
    const projectPath = relative(projectRoot, path);
    const parts = projectPath.split(sep);
    if (entry.name.endsWith(".test.vel") && !parts.includes("tests")) {
      violations.push(`${projectPath}: VelarScript tests belong under tests/`);
    }
    if (parts.includes("generated") && entry.name.endsWith(".vel")) {
      violations.push(`${projectPath}: generated artifacts cannot be VelarScript source`);
    }
    if (entry.name === "package.json") {
      const manifest = JSON.parse(await readFile(path, "utf8"));
      inspectDependencyFields(projectPath, manifest);
      inspectOpenVoxelBoundary(projectPath, manifest);
    }
  }
}

await inspect(join(projectRoot, "apps"));
await inspect(join(projectRoot, "packages"));

const lock = JSON.parse(await readFile(join(projectRoot, "package-lock.json"), "utf8"));
for (const [path, metadata] of Object.entries(lock.packages ?? {})) {
  const owner = `package-lock.json:${path === "" ? "<root>" : path}`;
  const installedName = metadata.name ?? /node_modules\/(?:.*\/node_modules\/)?(@[^/]+\/[^/]+|[^/]+)$/u.exec(path)?.[1];
  inspectDependencyFields(owner, metadata);
  if (typeof installedName === "string"
    && installedName.startsWith("@velarscript/")
    && !npmToolchainPackages.has(installedName)) {
    violations.push(`${owner}: installed non-standard package cannot use the @velarscript scope`);
  }
  if (typeof installedName === "string"
    && installedName.startsWith(labsScope)
    && (typeof metadata.resolved !== "string"
      || !metadata.resolved.startsWith(labsRegistryPrefix)
      || !metadata.resolved.endsWith(".tgz"))) {
    violations.push(`${owner}: installed Labs package must resolve from the public npm registry`);
  }
}

if (violations.length > 0) {
  throw new Error(`Project layout violations:\n${violations.map((item) => `- ${item}`).join("\n")}`);
}

console.log("Project layout is valid");
