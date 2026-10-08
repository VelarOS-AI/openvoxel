export const npmToolchainPackages = new Set([
  "@velarscript/cli",
  "@velarscript/compiler",
  "@velarscript/core",
  "@velarscript/desktop",
  "@velarscript/node",
  "@velarscript/server",
  "@velarscript/web",
]);
export const labsScope = "@velarscript-labs/";
export const labsRegistryPrefix = "https://registry.npmjs.org/@velarscript-labs/";
export const openVoxelGamePackage = "@openvoxel/game";
export const gameMeshingWorkerSpecifier = "@openvoxel/game/meshing-worker";
export const gameWorkerBridges = new Map([
  [gameMeshingWorkerSpecifier, "@openvoxel/renderer/meshing-worker"],
  ["@openvoxel/game/lighting-worker", "@openvoxel/renderer/lighting-worker"],
]);
export const openVoxelRendererPackage = "@openvoxel/renderer";
export const openVoxelWebPackage = "@openvoxel/web";
export const babylonPackagePrefix = "@babylonjs/";
export const gameBabylonBackendHome = "packages/client/game/src/backends/babylon";
export const gameBabylonTestHome = "packages/client/game/tests";
export const supportedTargets = new Set(["core", "node", "web", "desktop"]);
export const extensionEnvironments = new Map([
  ["@velarscript/node", { target: "node", capabilities: ["node"] }],
  ["@velarscript/server", { target: "node", capabilities: ["node"] }],
  ["@velarscript/web", { target: "web", capabilities: ["web"] }],
  ["@velarscript/desktop", { target: "desktop", capabilities: ["desktop", "node", "web"] }],
]);
export const allowedOpenVoxelDependencies = new Map([
  ["@openvoxel/identities", new Set()],
  ["@openvoxel/blocks", new Set(["@openvoxel/identities"])],
  ["@openvoxel/world", new Set(["@openvoxel/blocks"])],
  ["@openvoxel/world-generation", new Set(["@openvoxel/blocks", "@openvoxel/identities", "@openvoxel/world"])],
  ["@openvoxel/content", new Set(["@openvoxel/blocks", "@openvoxel/identities", "@openvoxel/world", "@openvoxel/world-generation"])],
  ["@openvoxel/protocol", new Set(["@openvoxel/blocks", "@openvoxel/world"])],
  ["@openvoxel/client", new Set(["@openvoxel/content", "@openvoxel/protocol", "@openvoxel/world", "@openvoxel/world-runtime"])],
  ["@openvoxel/renderer", new Set(["@openvoxel/blocks", "@openvoxel/protocol", "@openvoxel/world"])],
  ["@openvoxel/game", new Set(["@openvoxel/client", "@openvoxel/renderer", "@openvoxel/world"])],
  ["@openvoxel/world-runtime", new Set(["@openvoxel/blocks", "@openvoxel/content", "@openvoxel/world", "@openvoxel/world-generation"])],
  ["@openvoxel/server", new Set(["@openvoxel/blocks", "@openvoxel/content", "@openvoxel/protocol", "@openvoxel/world", "@openvoxel/world-generation", "@openvoxel/world-runtime"])],
  ["@openvoxel/web", new Set(["@openvoxel/client", "@openvoxel/content", "@openvoxel/game", "@openvoxel/protocol", "@openvoxel/world"])],
]);
export const packageHomes = new Map([
  ["@openvoxel/identities", "packages/content/identities"],
  ["@openvoxel/blocks", "packages/content/blocks"],
  ["@openvoxel/content", "packages/content/packs"],
  ["@openvoxel/world", "packages/world/model"],
  ["@openvoxel/world-generation", "packages/world/generation"],
  ["@openvoxel/world-runtime", "packages/world/runtime"],
  ["@openvoxel/client", "packages/client/access"],
  ["@openvoxel/renderer", "packages/client/rendering"],
  ["@openvoxel/game", "packages/client/game"],
  ["@openvoxel/protocol", "packages/protocol"],
  ["@openvoxel/server", "apps/server"],
  ["@openvoxel/web", "apps/web"],
]);

const dependencyFields = ["dependencies", "devDependencies", "optionalDependencies", "peerDependencies"];
const portablePath = (path) => path.replaceAll("\\", "/");
const openVoxelPackageName = (specifier) => {
  if (!specifier.startsWith("@openvoxel/")) return null;
  const [scope, name] = specifier.split("/");
  return name === undefined ? null : `${scope}/${name}`;
};
const containsBabylonName = (value) => typeof value === "string" && /Babylon/iu.test(value);
const isBabylonReference = (specifier) => specifier.startsWith(babylonPackagePrefix)
  || /(?:^|[/#_.-])babylon(?:[/#_.-]|$)/iu.test(specifier);

function manifestTargets(value) {
  if (typeof value === "string") return [value];
  if (Array.isArray(value)) return value.flatMap(manifestTargets);
  if (value !== null && typeof value === "object") return Object.values(value).flatMap(manifestTargets);
  return [];
}

/** Package-level ownership for the replaceable game graphics backend. */
export function renderingManifestViolations(manifest) {
  const messages = [];
  for (const field of dependencyFields) {
    for (const name of Object.keys(manifest[field] ?? {})) {
      if (name.startsWith(babylonPackagePrefix) && manifest.name !== openVoxelGamePackage) {
        messages.push(`${field} dependency ${name} is owned exclusively by ${openVoxelGamePackage}`);
      }
      if (manifest.name === openVoxelWebPackage && name === openVoxelRendererPackage) {
        messages.push(`${openVoxelWebPackage} must consume graphics through ${openVoxelGamePackage}, not ${openVoxelRendererPackage}`);
      }
    }
  }
  for (const [alias, target] of Object.entries(manifest.imports ?? {})) {
    const targets = manifestTargets(target);
    if (manifest.name !== openVoxelGamePackage && targets.some((value) => value.startsWith(babylonPackagePrefix))) {
      messages.push(`package import ${alias} cannot redirect to a Babylon package outside ${openVoxelGamePackage}`);
    }
    if (manifest.name === openVoxelRendererPackage) {
      if (isBabylonReference(alias) || targets.some(isBabylonReference)) {
        messages.push(`${openVoxelRendererPackage} package import ${alias} cannot reference Babylon`);
      }
    }
  }
  return messages;
}

/** File-level backend ownership. The returned messages are relative to the importing source. */
export function renderingImportViolations({ownerName, path, specifier}) {
  const messages = [];
  const projectPath = portablePath(path);
  if (specifier.startsWith(babylonPackagePrefix)) {
    const backendPrefix = `${gameBabylonBackendHome}/`;
    const testPrefix = `${gameBabylonTestHome}/`;
    const backendOwned = ownerName === openVoxelGamePackage
      && (projectPath.startsWith(backendPrefix) || projectPath.startsWith(testPrefix));
    if (!backendOwned) {
      messages.push(`${specifier} may only be imported by the game Babylon backend or its tests`);
    } else if (specifier === "@babylonjs/core") {
      messages.push("Babylon backend modules must import concrete responsibility modules, not @babylonjs/core");
    }
  }
  if (ownerName === openVoxelRendererPackage && isBabylonReference(specifier)) {
    messages.push(`${openVoxelRendererPackage} cannot import or alias Babylon backend modules`);
  }
  if (ownerName === openVoxelWebPackage && openVoxelPackageName(specifier) === openVoxelRendererPackage) {
    messages.push(`${openVoxelWebPackage} must import ${openVoxelGamePackage} instead of ${openVoxelRendererPackage}`);
  }
  return [...new Set(messages)];
}

/** Workers stay below the game/runtime and graphics-backend composition boundary. */
export function workerDependencyViolation(specifier, resolvedOwnerName = null, resolvesToGameWorkerBridge = false) {
  if (specifier.startsWith(babylonPackagePrefix)) return `Worker closure cannot import ${specifier}`;
  if (gameWorkerBridges.has(specifier) && resolvesToGameWorkerBridge) return null;
  if (openVoxelPackageName(specifier) === openVoxelGamePackage || resolvedOwnerName === openVoxelGamePackage) {
    return `Worker closure can enter ${openVoxelGamePackage} only through ${[...gameWorkerBridges.keys()].join(" or ")}`;
  }
  return null;
}

export function gameWorkerBridgeViolations(specifiers, entry = gameMeshingWorkerSpecifier) {
  const target = gameWorkerBridges.get(entry);
  return target !== undefined && specifiers.length === 1 && specifiers[0] === target
    ? []
    : [`${entry} must only forward ${target}`];
}

/** Traverse an already-resolved module graph so indirect worker leaks stay visible. */
export function workerClosureViolations(entry, modules) {
  const messages = [];
  const pending = [entry];
  const visited = new Set();
  while (pending.length > 0) {
    const path = pending.pop();
    if (visited.has(path)) continue;
    visited.add(path);
    const module = modules.get(path);
    if (module === undefined) continue;
    if (module.ownerName === openVoxelGamePackage && module.gameWorkerBridge !== true) {
      messages.push(`${path}: Worker closure cannot enter ${openVoxelGamePackage}`);
      continue;
    }
    for (const edge of module.edges) {
      const violation = workerDependencyViolation(
        edge.specifier,
        edge.resolvedOwnerName ?? null,
        edge.gameWorkerBridge === true,
      );
      if (violation !== null) messages.push(`${path}: ${violation}`);
      if (edge.target !== null && edge.target !== undefined) pending.push(edge.target);
    }
  }
  return [...new Set(messages)];
}

/**
 * Audit selected exports from one compiler module interface. Re-export targets are
 * resolved by the layout checker, then passed back through this same function.
 */
export function gamePublicInterfaceViolations(moduleInterface, selectedExports = null) {
  const messages = [];
  const roots = selectedExports === null
    ? new Set([...moduleInterface.exports.keys(), ...moduleInterface.reExports.keys()])
    : new Set(selectedExports);

  for (const exportName of roots) {
    if (containsBabylonName(exportName)) messages.push(`public export ${exportName} exposes a Babylon name`);
    const reExport = moduleInterface.reExports.get(exportName);
    if (reExport !== undefined) {
      if (containsBabylonName(reExport.imported)) {
        messages.push(`public export ${exportName} exposes Babylon symbol ${reExport.imported}`);
      }
      continue;
    }
    const descriptor = moduleInterface.exports.get(exportName);
    if (descriptor === undefined) continue;
    const seenObjects = new WeakSet();
    const seenNamedTypes = new Set();

    const inspect = (value, trail) => {
      if (value === null || value === undefined) return;
      if (typeof value === "string") {
        if (containsBabylonName(value)) messages.push(`public export ${exportName} exposes Babylon name ${value} at ${trail}`);
        return;
      }
      if (typeof value !== "object") return;
      if (seenObjects.has(value)) return;
      seenObjects.add(value);
      if (value.kind === "unknown") messages.push(`public export ${exportName} exposes an unknown native handle at ${trail}`);
      if (containsBabylonName(value.name)) {
        messages.push(`public export ${exportName} exposes Babylon type ${value.name} at ${trail}`);
      }
      if (value.kind === "named" && typeof value.name === "string"
        && moduleInterface.namedTypes.has(value.name) && !seenNamedTypes.has(value.name)) {
        seenNamedTypes.add(value.name);
        inspect(moduleInterface.namedTypes.get(value.name), `${trail}.${value.name}`);
      }
      if (value instanceof Map) {
        for (const [name, nested] of value) {
          if (containsBabylonName(name)) messages.push(`public export ${exportName} exposes Babylon member ${name} at ${trail}`);
          inspect(nested, `${trail}.${String(name)}`);
        }
        return;
      }
      if (Array.isArray(value)) {
        value.forEach((nested, index) => inspect(nested, `${trail}[${index}]`));
        return;
      }
      if (value instanceof Set) {
        for (const nested of value) inspect(nested, trail);
        return;
      }
      for (const [name, nested] of Object.entries(value)) {
        if (name === "identity" || name === "documentation") continue;
        inspect(nested, `${trail}.${name}`);
      }
    };

    inspect(descriptor, exportName);
    if (descriptor.kind === "classConstructor") {
      const classDefinition = moduleInterface.classes.get(descriptor.name)
        ?? moduleInterface.classes.get(descriptor.identity);
      inspect(classDefinition, `${exportName}.class`);
    }
  }
  return [...new Set(messages)];
}

/** Named types used by selected exports, including fields of local named types. */
export function publicInterfaceTypeReferences(moduleInterface, selectedExports = null) {
  const names = new Set();
  const roots = selectedExports === null
    ? new Set(moduleInterface.exports.keys())
    : new Set(selectedExports);
  const seenObjects = new WeakSet();
  const seenNamedTypes = new Set();
  const inspect = (value) => {
    if (value === null || value === undefined || typeof value !== "object") return;
    if (seenObjects.has(value)) return;
    seenObjects.add(value);
    if (value.kind === "named" && typeof value.name === "string") {
      names.add(value.name);
      if (moduleInterface.namedTypes.has(value.name) && !seenNamedTypes.has(value.name)) {
        seenNamedTypes.add(value.name);
        inspect(moduleInterface.namedTypes.get(value.name));
      }
    }
    if (value instanceof Map) {
      for (const nested of value.values()) inspect(nested);
      return;
    }
    if (Array.isArray(value)) {
      for (const nested of value) inspect(nested);
      return;
    }
    if (value instanceof Set) {
      for (const nested of value) inspect(nested);
      return;
    }
    for (const [key, nested] of Object.entries(value)) {
      if (key !== "identity" && key !== "documentation") inspect(nested);
    }
  };
  for (const exportName of roots) {
    const descriptor = moduleInterface.exports.get(exportName);
    if (descriptor === undefined) continue;
    inspect(descriptor);
    if (descriptor.kind === "classConstructor") {
      inspect(moduleInterface.classes.get(descriptor.name) ?? moduleInterface.classes.get(descriptor.identity));
    }
  }
  return names;
}

export function toolchainPinViolations(manifest, version) {
  const messages = [];
  for (const field of ["dependencies", "devDependencies", "optionalDependencies", "peerDependencies"]) {
    for (const [name, specification] of Object.entries(manifest[field] ?? {})) {
      if (npmToolchainPackages.has(name) && specification !== version) {
        messages.push(name + " must pin the root CLI version " + version + " exactly, received " + specification);
      }
    }
  }
  return messages;
}

export function installedToolchainViolation(name, metadata, version) {
  return npmToolchainPackages.has(name) && metadata.version !== version
    ? name + " installed version " + metadata.version + " must match the root CLI version " + version
    : null;
}
