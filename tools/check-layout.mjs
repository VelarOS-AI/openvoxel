import { access, readFile, readdir } from "node:fs/promises";
import { dirname, join, relative, sep } from "node:path";

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
const supportedTargets = new Set(["core", "node", "web", "desktop"]);
const extensionEnvironments = new Map([
  ["@velarscript/node", { target: "node", capabilities: ["node"] }],
  ["@velarscript/server", { target: "node", capabilities: ["node"] }],
  ["@velarscript/web", { target: "web", capabilities: ["web"] }],
  ["@velarscript/desktop", { target: "desktop", capabilities: ["desktop", "node", "web"] }],
]);
const allowedOpenVoxelDependencies = new Map([
  ["@openvoxel/identities", new Set()],
  ["@openvoxel/blocks", new Set(["@openvoxel/identities"])],
  ["@openvoxel/world", new Set(["@openvoxel/blocks"])],
  ["@openvoxel/world-generation", new Set(["@openvoxel/blocks", "@openvoxel/identities", "@openvoxel/world"])],
  ["@openvoxel/content", new Set(["@openvoxel/blocks", "@openvoxel/identities", "@openvoxel/world", "@openvoxel/world-generation"])],
  ["@openvoxel/protocol", new Set(["@openvoxel/blocks", "@openvoxel/world"])],
  ["@openvoxel/client", new Set(["@openvoxel/protocol", "@openvoxel/world", "@openvoxel/world-runtime"])],
  ["@openvoxel/renderer", new Set(["@openvoxel/blocks", "@openvoxel/protocol", "@openvoxel/world"])],
  ["@openvoxel/world-runtime", new Set(["@openvoxel/blocks", "@openvoxel/content", "@openvoxel/world", "@openvoxel/world-generation"])],
  ["@openvoxel/server", new Set(["@openvoxel/blocks", "@openvoxel/content", "@openvoxel/protocol", "@openvoxel/world", "@openvoxel/world-generation", "@openvoxel/world-runtime"])],
  ["@openvoxel/web", new Set(["@openvoxel/client", "@openvoxel/renderer", "@openvoxel/protocol", "@openvoxel/world"])],
]);
const packageHomes = new Map([
  ["@openvoxel/identities", "packages/content/identities"],
  ["@openvoxel/blocks", "packages/content/blocks"],
  ["@openvoxel/content", "packages/content/packs"],
  ["@openvoxel/world", "packages/world/model"],
  ["@openvoxel/world-generation", "packages/world/generation"],
  ["@openvoxel/world-runtime", "packages/world/runtime"],
  ["@openvoxel/client", "packages/client/access"],
  ["@openvoxel/renderer", "packages/client/rendering"],
  ["@openvoxel/protocol", "packages/protocol"],
  ["@openvoxel/server", "apps/server"],
  ["@openvoxel/web", "apps/web"],
]);
const violations = [];
const projectPackages = new Map();

function declaredEnvironment(owner, manifest, canonicalCore) {
  const targets = manifest.velar?.targets;
  const capabilities = manifest.velar?.requires?.capabilities;
  if (!Array.isArray(targets) || targets.length === 0 || targets.some((target) => !supportedTargets.has(target))) {
    violations.push(`${owner}: velar.targets must declare one or more of core, node, web, or desktop`);
    return null;
  }
  if (new Set(targets).size !== targets.length) {
    violations.push(`${owner}: velar.targets cannot repeat an environment`);
  }
  if (!Array.isArray(capabilities) || capabilities.some((capability) => typeof capability !== "string" || capability.length === 0)) {
    violations.push(`${owner}: velar.requires.capabilities must explicitly declare an array`);
    return null;
  }
  if (new Set(capabilities).size !== capabilities.length) {
    violations.push(`${owner}: velar.requires.capabilities cannot repeat a capability`);
  }
  if (canonicalCore && targets.includes("core") && targets.length !== 1) {
    violations.push(`${owner}: portable packages declare only the core target`);
  }
  if (targets.includes("core") && capabilities.length > 0) {
    violations.push(`${owner}: a Core package cannot require a host capability`);
  }
  return { targets: new Set(targets), capabilities: new Set(capabilities) };
}

async function applicationEnvironment(owner, manifestPath) {
  let projectManifest;
  try {
    projectManifest = JSON.parse(await readFile(join(dirname(manifestPath), "velar.json"), "utf8"));
  } catch (error) {
    if (error?.code === "ENOENT") return null;
    throw error;
  }
  const environments = (projectManifest.extensions ?? [])
    .map((extension) => extensionEnvironments.get(extension))
    .filter((environment) => environment !== undefined);
  if (environments.length !== 1) {
    violations.push(`${owner}: application must activate exactly one target-owning VelarScript extension`);
    return null;
  }
  return {
    targets: new Set([environments[0].target]),
    capabilities: new Set(environments[0].capabilities),
  };
}

function inspectEnvironmentCompatibility(owner, consumer, dependencyName, dependency) {
  if (consumer === null || dependency === null) return;
  for (const target of consumer.targets) {
    if (!dependency.targets.has("core") && !dependency.targets.has(target)) {
      violations.push(`${owner}: ${dependencyName} does not support the ${target} environment`);
    }
  }
  for (const capability of dependency.capabilities) {
    if (!consumer.capabilities.has(capability)) {
      violations.push(`${owner}: ${dependencyName} requires the ${capability} host capability`);
    }
  }
}

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
      const portableProjectPath = projectPath.split(sep).join("/");
      inspectDependencyFields(projectPath, manifest);
      inspectOpenVoxelBoundary(projectPath, manifest);
      if (typeof manifest.name === "string" && manifest.name.startsWith("@openvoxel/")) {
        const expectedHome = packageHomes.get(manifest.name);
        if (expectedHome === undefined) {
          violations.push(`${projectPath}: ${manifest.name} has no registered responsibility home`);
        } else if (portableProjectPath !== `${expectedHome}/package.json`) {
          violations.push(`${projectPath}: ${manifest.name} belongs at ${expectedHome}/package.json`);
        }
        const environment = manifest.velar?.entry
          ? declaredEnvironment(projectPath, manifest, true)
          : await applicationEnvironment(projectPath, path);
        if (environment === null) {
          violations.push(`${projectPath}: OpenVoxel package must declare or derive its execution environment`);
        }
        if (projectPackages.has(manifest.name)) {
          violations.push(`${projectPath}: duplicate OpenVoxel package name ${manifest.name}`);
        }
        projectPackages.set(manifest.name, { owner: projectPath, manifest, environment });
      }
    }
  }
}

async function inspectDocumentPaths(target) {
  let entries;
  try {
    entries = await readdir(target, { withFileTypes: true });
  } catch (error) {
    if (error?.code === "ENOTDIR") {
      const source = await readFile(target, "utf8");
      if (source.includes("状态：已被")) return;
      for (const match of source.matchAll(/`(packages\/[^`*]+)`/gu)) {
        try {
          await access(join(projectRoot, match[1]));
        } catch (pathError) {
          if (pathError?.code !== "ENOENT") throw pathError;
          violations.push(`${relative(projectRoot, target)}: documented project path does not exist: ${match[1]}`);
        }
      }
      return;
    }
    throw error;
  }
  for (const entry of entries) {
    if (entry.isDirectory() && ignoredDirectories.has(entry.name)) continue;
    const path = join(target, entry.name);
    if (entry.isDirectory()) {
      await inspectDocumentPaths(path);
    } else if (entry.isFile() && entry.name.endsWith(".md")) {
      await inspectDocumentPaths(path);
    }
  }
}

await inspect(join(projectRoot, "apps"));
await inspect(join(projectRoot, "packages"));
await inspectDocumentPaths(join(projectRoot, "README.md"));
await inspectDocumentPaths(join(projectRoot, "docs"));

for (const [packageName, home] of packageHomes) {
  if (!projectPackages.has(packageName)) {
    violations.push(`${home}/package.json: missing registered OpenVoxel package ${packageName}`);
  }
}

const labsEnvironments = new Map();
for (const { owner, manifest, environment } of projectPackages.values()) {
  for (const dependencyName of Object.keys(manifest.dependencies ?? {})) {
    if (dependencyName.startsWith("@openvoxel/")) {
      const dependency = projectPackages.get(dependencyName);
      if (dependency === undefined) {
        violations.push(`${owner}: missing internal package ${dependencyName}`);
      } else {
        inspectEnvironmentCompatibility(owner, environment, dependencyName, dependency.environment);
      }
    }
    if (dependencyName.startsWith(labsScope)) {
      let dependencyEnvironment = labsEnvironments.get(dependencyName);
      if (dependencyEnvironment === undefined) {
        try {
          const installedManifestPath = join(projectRoot, "node_modules", ...dependencyName.split("/"), "package.json");
          const installedManifest = JSON.parse(await readFile(installedManifestPath, "utf8"));
          dependencyEnvironment = declaredEnvironment(`node_modules/${dependencyName}/package.json`, installedManifest, false);
        } catch (error) {
          if (error?.code !== "ENOENT") throw error;
          violations.push(`${owner}: Labs package ${dependencyName} is not installed`);
          dependencyEnvironment = null;
        }
        labsEnvironments.set(dependencyName, dependencyEnvironment);
      }
      inspectEnvironmentCompatibility(owner, environment, dependencyName, dependencyEnvironment);
    }
  }
}

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
