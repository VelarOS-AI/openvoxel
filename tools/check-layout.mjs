import {access, readFile, readdir} from "node:fs/promises";
import {dirname, extname, isAbsolute, join, relative, resolve, sep} from "node:path";
import {fileURLToPath} from "node:url";
import {inspectModule} from "@velarscript/compiler";
import {velarCompilerExtension as nodeExtension} from "@velarscript/node/compiler";
import {velarCompilerExtension as webExtension} from "@velarscript/web/compiler";
import {inspectSourceBoundaries, moduleEdges, publicEntryTargets} from "./architecture/module-boundaries.mjs";
import {allowedOpenVoxelDependencies, extensionEnvironments, gameMeshingWorkerSpecifier, gamePublicInterfaceViolations, gameWorkerBridgeViolations, installedToolchainViolation, labsRegistryPrefix, labsScope, npmToolchainPackages, openVoxelGamePackage, packageHomes, publicInterfaceTypeReferences, renderingImportViolations, renderingManifestViolations, supportedTargets, toolchainPinViolations, workerClosureViolations} from "./architecture/policy.mjs";

const projectRoot = fileURLToPath(new URL("../", import.meta.url));
const rootManifest = JSON.parse(await readFile(join(projectRoot, "package.json"), "utf8"));
const toolchainVersion = rootManifest.devDependencies?.["@velarscript/cli"];
if (typeof toolchainVersion !== "string" || !/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/u.test(toolchainVersion)) {
  throw new Error("Root @velarscript/cli must pin one exact release version");
}
const ignoredDirectories = new Set([".git", ".velar", "dist", "node_modules"]);
const graphIgnoredDirectories = new Set([...ignoredDirectories, "generated"]);
const codeExtensions = new Set([".vel", ".js", ".mjs"]);
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
  violations.push(...toolchainPinViolations(manifest, toolchainVersion).map((message) => owner + ": " + message));
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
    const portableProjectPath = projectPath.split(sep).join("/");
    const parts = projectPath.split(sep);
    if (entry.name.endsWith(".test.vel") && !parts.includes("tests")) {
      violations.push(`${projectPath}: VelarScript tests belong under tests/`);
    }
    if (parts.includes("generated") && entry.name.endsWith(".vel")) {
      violations.push(`${projectPath}: generated artifacts cannot be VelarScript source`);
    }
    if (entry.name.endsWith(".vel") && !parts.includes("tests") && !parts.includes("benchmarks")) {
      const source = await readFile(path, "utf8");
      if (/^\s*extern\s+js\b/mu.test(source)) {
        violations.push(`${projectPath}: production JavaScript belongs in a native module reached through extern module`);
      }
      if (portableProjectPath === "apps/web/src/main.vel") {
        for (const [modulePath, exportName] of [
          ["./pages/create-world-page.vel", "CreateWorldPage"],
          ["./pages/open-world-page.vel", "OpenWorldPage"],
          ["./pages/world-page.vel", "WorldPage"],
        ]) {
          if (!source.includes(`lazy(() => import("${modulePath}"), "${exportName}"`)) {
            violations.push(`${projectPath}: ${exportName} must remain a lazy route boundary`);
          }
        }
      }
    }
    if ((entry.name.endsWith(".js") || entry.name.endsWith(".mjs"))
      && !parts.includes("tests") && !parts.includes("generated")) {
      const source = await readFile(path, "utf8");
      if (/\b(?:from\s+|import\s*)["']@babylonjs\/core["']/u.test(source)) {
        violations.push(`${projectPath}: Babylon adapters must import concrete responsibility modules`);
      }
    }
    if (entry.name === "package.json") {
      const manifest = JSON.parse(await readFile(path, "utf8"));
      inspectDependencyFields(projectPath, manifest);
      violations.push(...renderingManifestViolations(manifest).map((message) => `${projectPath}: ${message}`));
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

const portable = (path) => path.split(sep).join("/");
const ownsPath = (home, path) => {
  const local = relative(home, path);
  return local === "" || (!local.startsWith(`..${sep}`) && local !== ".." && !isAbsolute(local));
};

function configuredTargets(value) {
  if (typeof value === "string") return [value];
  if (Array.isArray(value)) return value.flatMap(configuredTargets);
  if (value !== null && typeof value === "object") return Object.values(value).flatMap(configuredTargets);
  return [];
}

function mappedTargets(mapping, key) {
  if (mapping === null || typeof mapping !== "object") return [];
  if (Object.hasOwn(mapping, key)) return configuredTargets(mapping[key]);
  const patterns = Object.keys(mapping).filter((pattern) => pattern.includes("*"))
    .sort((left, right) => right.length - left.length);
  for (const pattern of patterns) {
    const [before, after] = pattern.split("*");
    if (!key.startsWith(before) || !key.endsWith(after) || key.length < before.length + after.length) continue;
    const matched = key.slice(before.length, after.length === 0 ? undefined : -after.length);
    return configuredTargets(mapping[pattern]).map((target) => target.replaceAll("*", matched));
  }
  return [];
}

function expandedImportSpecifiers(manifest, specifier, seen = new Set()) {
  if (!specifier.startsWith("#") || seen.has(specifier)) return [specifier];
  seen.add(specifier);
  const expanded = mappedTargets(manifest.imports, specifier)
    .flatMap((target) => expandedImportSpecifiers(manifest, target, seen));
  seen.delete(specifier);
  return [specifier, ...expanded];
}

async function graphSourcePaths(directory) {
  const paths = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    if (entry.isDirectory() && graphIgnoredDirectories.has(entry.name)) continue;
    const path = join(directory, entry.name);
    if (entry.isDirectory()) paths.push(...await graphSourcePaths(path));
    else if (entry.isFile() && codeExtensions.has(extname(path))) paths.push(path);
  }
  return paths;
}

async function inspectRenderingArchitecture() {
  const packages = new Map([...projectPackages].map(([name, value]) => [name, {
    ...value,
    home: resolve(projectRoot, dirname(value.owner)),
  }]));
  const ownerForPath = (path) => [...packages.values()].find((owner) => ownsPath(owner.home, path));
  const extensions = new Map();
  const compilerExtensions = async (owner) => {
    if (extensions.has(owner.home)) return extensions.get(owner.home);
    let configuration;
    try {
      configuration = JSON.parse(await readFile(join(owner.home, "velar.json"), "utf8"));
    } catch (error) {
      if (error?.code !== "ENOENT") throw error;
      configuration = {};
    }
    const enabled = [];
    if (configuration.extensions?.some((name) => name === "@velarscript/web" || name === "@velarscript/desktop")) enabled.push(webExtension);
    if (configuration.extensions?.some((name) => name === "@velarscript/node" || name === "@velarscript/server" || name === "@velarscript/desktop")) enabled.push(nodeExtension);
    extensions.set(owner.home, enabled);
    return enabled;
  };

  const modules = new Map();
  for (const owner of packages.values()) {
    for (const path of await graphSourcePaths(owner.home)) {
      const source = await readFile(path, "utf8");
      let edges;
      try {
        edges = moduleEdges(source, path, await compilerExtensions(owner));
      } catch {
        // inspectSourceBoundaries reports the compiler failure once with its full diagnostic.
        continue;
      }
      const projectPath = portable(relative(projectRoot, path));
      for (const edge of edges) {
        for (const specifier of expandedImportSpecifiers(owner.manifest, edge.source)) {
          violations.push(...renderingImportViolations({
            ownerName: owner.manifest.name,
            path: projectPath,
            specifier,
          }).map((message) => `${projectPath}:${source.slice(0, edge.start).split("\n").length}: ${message}`));
        }
      }
      modules.set(path, { path, owner, ownerName: owner.manifest.name, source, rawEdges: edges, edges: [] });
    }
  }

  const sourcePath = (candidate) => {
    const clean = candidate.split(/[?#]/u)[0];
    for (const path of [clean, `${clean}.vel`, `${clean}.mjs`, `${clean}.js`, join(clean, "index.vel"), join(clean, "index.mjs"), join(clean, "index.js")]) {
      if (modules.has(path)) return path;
    }
    return null;
  };
  const packageName = (specifier) => {
    if (!specifier.startsWith("@openvoxel/")) return null;
    const [scope, name] = specifier.split("/");
    return name === undefined ? null : `${scope}/${name}`;
  };
  const resolveSpecifier = (module, specifier, seenAliases = new Set()) => {
    if (specifier.startsWith("#")) {
      if (seenAliases.has(specifier)) return [];
      seenAliases.add(specifier);
      const resolved = mappedTargets(module.owner.manifest.imports, specifier)
        .flatMap((target) => resolveSpecifier(module, target.startsWith(".") ? resolve(module.owner.home, target) : target, seenAliases));
      seenAliases.delete(specifier);
      return resolved;
    }
    const dependencyName = packageName(specifier);
    if (dependencyName !== null) {
      const dependency = packages.get(dependencyName);
      if (dependency === undefined) return [];
      const segments = specifier.split("/").slice(2);
      const subpath = segments.length === 0 ? "." : `./${segments.join("/")}`;
      return publicEntryTargets(dependency.manifest, subpath).map((target) => {
        const path = sourcePath(resolve(dependency.home, target));
        return { path, ownerName: dependencyName };
      });
    }
    if (specifier.startsWith(".") || isAbsolute(specifier) || specifier.startsWith("file:")) {
      const absolute = specifier.startsWith("file:")
        ? fileURLToPath(specifier)
        : isAbsolute(specifier) ? specifier : resolve(dirname(module.path), specifier);
      const path = sourcePath(absolute);
      return [{ path, ownerName: path === null ? null : ownerForPath(path)?.manifest.name ?? null }];
    }
    return [];
  };

  // Resolve the static graph once. Public API and Worker closure checks consume
  // the same graph, so their definition of a package edge cannot drift apart.
  for (const [path, module] of modules) {
    for (const edge of module.rawEdges) {
      const targets = resolveSpecifier(module, edge.source);
      if (targets.length === 0) {
        module.edges.push({ specifier: edge.source, target: null, resolvedOwnerName: null });
        continue;
      }
      for (const target of targets) {
        module.edges.push({
          specifier: edge.source,
          target: target.path,
          resolvedOwnerName: target.ownerName,
          gameWorkerBridge: edge.source === gameMeshingWorkerSpecifier && target.path !== null,
        });
      }
    }
  }

  const game = packages.get(openVoxelGamePackage);
  const gameWorkerBridgePaths = new Set();
  if (game !== undefined) {
    for (const target of publicEntryTargets(game.manifest, "./meshing-worker")) {
      const path = sourcePath(resolve(game.home, target));
      if (path !== null) gameWorkerBridgePaths.add(path);
    }
    if (gameWorkerBridgePaths.size === 0) {
      violations.push(`${game.owner}: ${openVoxelGamePackage} must declare the ${gameMeshingWorkerSpecifier} Velar entry`);
    }
  }
  for (const [path, module] of modules) {
    module.gameWorkerBridge = gameWorkerBridgePaths.has(path);
  }
  for (const path of gameWorkerBridgePaths) {
    const imports = modules.get(path)?.rawEdges.map((edge) => edge.source) ?? [];
    violations.push(...gameWorkerBridgeViolations(imports)
      .map((message) => `${portable(relative(projectRoot, path))}: ${message}`));
  }

  if (game !== undefined) {
    const inspectedModules = new Map();
    const inspectedModule = async (path) => {
      if (extname(path) !== ".vel" || !modules.has(path)) return null;
      if (inspectedModules.has(path)) return inspectedModules.get(path);
      const module = modules.get(path);
      const inspected = inspectModule(module.source, { path, extensions: await compilerExtensions(module.owner) });
      const result = inspected.diagnostics.length === 0 ? inspected : null;
      inspectedModules.set(path, result);
      return result;
    };
    const visitedExports = new Set();
    const inspectExport = async (path, exportName) => {
      const key = `${path}#${exportName}`;
      if (visitedExports.has(key)) return;
      visitedExports.add(key);
      const inspected = await inspectedModule(path);
      if (inspected === null) return;
      const contract = inspected.moduleInterface;
      const projectPath = portable(relative(projectRoot, path));
      violations.push(...gamePublicInterfaceViolations(contract, [exportName])
        .map((message) => `${projectPath}: ${message}`));
      const module = modules.get(path);
      for (const typeName of publicInterfaceTypeReferences(contract, [exportName])) {
        for (const imported of inspected.semanticIndex.imports.filter((binding) => binding.local === typeName)) {
          for (const target of resolveSpecifier(module, imported.source)) {
            if (target.path !== null) await inspectExport(target.path, imported.imported);
          }
        }
      }
      const reExport = contract.reExports.get(exportName);
      if (reExport === undefined) return;
      for (const target of resolveSpecifier(module, reExport.source)) {
        if (target.path === null) continue;
        const targetInspected = await inspectedModule(target.path);
        if (targetInspected === null) continue;
        const targetContract = targetInspected.moduleInterface;
        if (reExport.imported === "*") {
          for (const name of new Set([...targetContract.exports.keys(), ...targetContract.reExports.keys()])) {
            await inspectExport(target.path, name);
          }
        } else {
          await inspectExport(target.path, reExport.imported);
        }
      }
    };
    // The root is the reusable game API. The host-only meshing Worker entry has
    // a restricted platform return and is instead governed by the closure gate.
    for (const entry of new Set(configuredTargets(game.manifest.velar?.entry))) {
      const path = sourcePath(resolve(game.home, entry));
      if (path === null || extname(path) !== ".vel") continue;
      const inspected = await inspectedModule(path);
      if (inspected === null) continue;
      const contract = inspected.moduleInterface;
      for (const name of new Set([...contract.exports.keys(), ...contract.reExports.keys()])) {
        await inspectExport(path, name);
      }
    }
  }

  for (const owner of packages.values()) {
    let configuration;
    try {
      configuration = JSON.parse(await readFile(join(owner.home, "velar.json"), "utf8"));
    } catch (error) {
      if (error?.code === "ENOENT") continue;
      throw error;
    }
    for (const [name, entry] of Object.entries(configuration.workers ?? {})) {
      for (const target of configuredTargets(entry)) {
        const path = sourcePath(resolve(owner.home, target));
        if (path === null) {
          violations.push(`${owner.owner}: Worker ${name} entry does not resolve to source: ${target}`);
          continue;
        }
        violations.push(...workerClosureViolations(path, modules)
          .map((message) => `${owner.owner}: Worker ${name}: ${portable(message.replaceAll(`${projectRoot}${sep}`, ""))}`));
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

inspectDependencyFields("package.json", rootManifest);
violations.push(...renderingManifestViolations(rootManifest).map((message) => `package.json: ${message}`));
await inspect(join(projectRoot, "apps"));
await inspect(join(projectRoot, "packages"));
await inspectDocumentPaths(join(projectRoot, "README.md"));
await inspectDocumentPaths(join(projectRoot, "docs"));

for (const [packageName, home] of packageHomes) {
  if (!projectPackages.has(packageName)) {
    violations.push(`${home}/package.json: missing registered OpenVoxel package ${packageName}`);
  }
}

await inspectRenderingArchitecture();
violations.push(...await inspectSourceBoundaries(projectRoot, projectPackages));

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
  const versionViolation = installedToolchainViolation(installedName, metadata, toolchainVersion);
  if (versionViolation !== null) violations.push(owner + ": " + versionViolation);
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
