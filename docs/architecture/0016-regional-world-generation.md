# Regional world generation

The survival generator uses algorithm revision 7. Its continental skeleton,
hydrology, regional ecology and surface materials share world coordinates. A
region is an exploration and content ownership unit; a Chunk is a bounded
projection of the world.

## Regions and habitats

`WorldGeneratorDefinition.regions` configures 288-block owner cells, jittered
centers, a continuous domain warp and a 64-block transition band. Each region
samples the existing base climate at its center to select a coherent habitat from the assembled biome units. Pack contracts and composition are described in [ADR 0017](0017-composable-ecosystem-packs.md).
Centers inside the transition band all contribute to forest cover, relief and
uplift. Forest edges and region junctions therefore have continuous density and
terrain transitions. Final elevation, rivers and shores select local overlays.

| Habitat | Landscape and ecology |
| --- | --- |
| Meadow | Gentle rolling land, open views, spatial flower patches |
| Plains | Open mixed grassland with occasional trees |
| Birch forest | Birch-dominant canopy with patches of forest soil |
| Forest | Oak-dominant woodland, podzol, moss, ferns and mushrooms |
| Taiga | Dense spruce woodland, tall spruce, podzol and moss |
| Wetland | Gentle relief, mud and moss, poplars, more lowland pools |
| Savanna | Sparse mimosa, coarse soil and dry ground cover |
| Steppe | Cool dry grassland, coarse soil and very few trees |
| Desert | Wind-shaped low dunes, sand, cactus and dry scrub |
| Badlands | Raised interior plateaus, red sand and world-height sediment bands |
| Tundra | Sparse cold vegetation and open terrain |
| Alpine | Elevated rock and scree above the continuous tree line |
| Ocean / coast / river | Hydrological overlays over the underlying region |

The terrain keeps its density-based overhangs and caves. Regional uplift fades
toward the shoreline; mountains remain controlled by the independent ridge
and erosion fields. Wetland pools use the basin planner's sealed floor and
water level. Trees, fallen wood and vines use deterministic feature
owners and clip their writes into each receiving Chunk. Fallen trees have 6–10
blocks of continuous trunk, asymmetric branch remnants and a broken root.
Independent stumps make up 6% of deadwood candidates. The complete footprint
checks water, roads and support; the rigid trunk can span a one-block hollow.

## Ground layers

Grass, podzol and moss cap a 3–6 block soil profile, including at least two
blocks of dirt below the cap. Erosion thins soil on slopes; exposed cliffs use
the local rock. Beaches and sandy river beds keep 3–6 blocks of loose sand
above native rock, while desert sand rests on deeper sandstone. Only maritime
lowlands qualify as dry beaches. River materials cover the wet channel and
its immediate bank; higher valley slopes keep their regional soil.

## Gameplay integration

Every built-in survival `generator.sample({x, z})` returns:

- `biome`: the final habitat, including river, shore and alpine overlays.
- `region.id`: a stable `region:<cellX>:<cellZ>` identifier scoped to the world.
- `region.center` and `region.biome`: the underlying region and its habitat.
- `region.neighboringBiome` and `region.edgeDistance`: nearby transition context.
- `region.forestCover`, `relief` and `upland`: blended generation facts.

Resource tables, creature spawning and encounters can key definitions by
`biome` and persistent regional state by `(worldId, region.id)`. The region
identity remains the same across a river or a Chunk boundary. These are
generation facts; saved block edits remain owned by the world runtime.

Region sampling lives in `world-generation`. Content definitions own block
physics, plant support and texture bindings. Renderer materials consume those
bindings and use continuous world-space tonal variation to break up surface
tiling. They do not independently choose the world's habitats.

## Assets and review

Eleven native 32×32 textures from Faithful supply podzol, moss, mud, coarse soil,
red sand, sedimentary colors, ferns and mushrooms. The exact source commit and
file checksums are recorded in `packages/client/rendering/data/region-texture-source.md`.
The resource compiler builds normal/material maps using the existing profiles.

`npm run test:terrain -- regional-review --regions --radius=4` discovers real
generated habitats and saves screenshots and sampled region metadata under
`packages/client/game/generated/terrain-tour/regional-review/`. `--sites=` can
select individual biome names, such as `forest,birch_forest,wetland,badlands`.
Build the generation and game workspaces before running the tour.

Focused regional tests cover stable ownership after cache eviction, negative
coordinates, habitat diversity, transition continuity, adjacent Chunk halos,
surface material identity and preservation of the ocean floor. The wider
generation suite checks hydrology, caves, feature ownership, spawn safety and
fixed-seed output.
