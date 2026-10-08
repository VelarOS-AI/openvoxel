import {readFile} from "node:fs/promises";
import {renderBlockPreview, renderPlantPreview} from "./block-preview-renderer.mjs";

const readArtifact = async specifier => JSON.parse(await readFile(new URL(import.meta.resolve(specifier)), "utf8"));

/** Inventory follows the installed content catalogs and the renderer's public model/texture artifacts. */
export async function buildCreativePreviewAssets() {
  const [base, packs, resources] = await Promise.all([
    readArtifact("@openvoxel/blocks/block-catalog-data"),
    readArtifact("@openvoxel/content/builtin-packs-data"),
    readArtifact("@openvoxel/renderer/resource-pack-data"),
  ]);
  const textures = new Map(resources.textures.map(texture => [texture.key, texture]));
  const banks = new Map(resources.textureBanks.map(bank => [bank.key, {
    ...bank.levels[0], pixels: Buffer.from(bank.levels[0].albedoData, "base64"), layerCount: bank.layerCount,
  }]));
  const models = new Map(resources.models.map(model => [model.key, model]));
  const tints = new Map(resources.tints.map(tint => [tint.key, tint]));
  const sampledTextures = new Map();
  function textureFor(key) {
    if (sampledTextures.has(key)) return sampledTextures.get(key);
    const texture = textures.get(key);
    const bank = banks.get(texture?.bankKey);
    const layer = texture?.variants?.[0]?.layer;
    if (!bank || !Number.isInteger(layer) || layer < 0 || layer >= bank.layerCount) {
      throw new Error(`Missing inventory texture ${key}`);
    }
    const layerBytes = bank.width * bank.height * 4;
    const sample = {width: bank.width, height: bank.height,
      pixels: bank.pixels.subarray(layer * layerBytes, (layer + 1) * layerBytes)};
    sampledTextures.set(key, sample);
    return sample;
  }
  const baseProfiles = new Map(base.catalog.componentProfiles.map(profile => [profile.profileId, profile]));
  const catalogs = [{...base.catalog, states: base.catalog.states.map(state => ({
    ...state, render: baseProfiles.get(state.componentProfileId).render,
  }))}, ...packs.filter(pack => pack.blocks).map(pack => pack.blocks.catalog)];
  const previews = [];
  const names = new Set();
  for (const catalog of catalogs) {
    const states = new Map(catalog.states.map(state => [state.runtimeId, state]));
    for (const block of catalog.blocks) {
      const state = states.get(block.defaultStateRuntimeId);
      const render = state.render;
      if (render.model === null) continue;
      const previewName = block.key.replaceAll(":", "--").replaceAll("_", "-");
      if (!/^[a-z][a-z0-9-]*$/u.test(previewName) || names.has(previewName)) {
        throw new Error(`Invalid or duplicate block preview ${block.key}`);
      }
      names.add(previewName);
      const model = models.get(render.model);
      if (!model) throw new Error(`Missing inventory model ${render.model}`);
      const properties = Object.fromEntries(state.properties.map(property => [property.name, property.value]));
      const attachments = render.attachments ?? [];
      // Aquatic plants are carried by fluid cells; their item represents the attached plant.
      const surfaces = model.kind === "fluid" && attachments.length ? attachments : [render, ...attachments];
      const parts = surfaces.map(surface => {
        const model = models.get(surface.model);
        if (!model) throw new Error(`Missing inventory attachment model ${surface.model}`);
        return {render: surface, model, tint: tints.get(surface.tint)};
      });
      const flatPlant = parts.every(part => ["cross", "submerged_cross", "wall_overlay"].includes(part.model.kind));
      const bytes = flatPlant ? await renderPlantPreview(parts.at(-1), textureFor)
        : await renderBlockPreview(parts, properties, textureFor);
      previews.push({previewName, bytes});
    }
  }
  return previews;
}
