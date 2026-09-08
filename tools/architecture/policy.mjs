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
  ["@openvoxel/client", new Set(["@openvoxel/protocol", "@openvoxel/world", "@openvoxel/world-runtime"])],
  ["@openvoxel/renderer", new Set(["@openvoxel/blocks", "@openvoxel/protocol", "@openvoxel/world"])],
  ["@openvoxel/world-runtime", new Set(["@openvoxel/blocks", "@openvoxel/content", "@openvoxel/world", "@openvoxel/world-generation"])],
  ["@openvoxel/server", new Set(["@openvoxel/blocks", "@openvoxel/content", "@openvoxel/protocol", "@openvoxel/world", "@openvoxel/world-generation", "@openvoxel/world-runtime"])],
  ["@openvoxel/web", new Set(["@openvoxel/client", "@openvoxel/renderer", "@openvoxel/protocol", "@openvoxel/world"])],
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
  ["@openvoxel/protocol", "packages/protocol"],
  ["@openvoxel/server", "apps/server"],
  ["@openvoxel/web", "apps/web"],
]);

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
