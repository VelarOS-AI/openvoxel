# Survivalcraft terrain texture mapping

Source: the local `SurvivalcraftApi-SCAPI1.9` project's
`Survivalcraft/Content/Assets/Textures/Blocks.webp` (512×512, 16×16 tiles).
All tiles below are copied as 32×32 PNGs with identical decoded RGBA pixels.
Slot numbers are zero-based and read left to right, top to bottom.

| OpenVoxel texture | Slot | Survivalcraft definition |
| --- | ---: | --- |
| stone, granite | 1 | GraniteBlock.DefaultTextureSlot |
| limestone | 5 | LimestoneBlock.DefaultTextureSlot |
| basalt | 6 | BasaltBlock.DefaultTextureSlot |
| marble | 7 | MarbleBlock.DefaultTextureSlot |
| clay | 8 | ClayBlock.DefaultTextureSlot |
| sand | 18 | SandBlock.DefaultTextureSlot |
| gravel | 19 | GravelBlock.DefaultTextureSlot |
| copper_ore | 32 | CopperOreBlock.DefaultTextureSlot |
| iron_ore | 33 | IronOreBlock.DefaultTextureSlot |
| coal_ore | 34 | CoalOreBlock.DefaultTextureSlot |
| saltpeter_ore | 35 | SaltpeterOreBlock.DefaultTextureSlot |
| sulphur_ore | 36 | SulphurOreBlock.DefaultTextureSlot |
| pale_basalt | 40 | BasaltBlock colored texture slot |
| diamond_ore | 48 | DiamondOreBlock.DefaultTextureSlot |
| germanium_ore | 49 | GermaniumOreBlock.DefaultTextureSlot |
| sandstone | 176 | SandstoneBlock.DefaultTextureSlot |

Default slots come from `Survivalcraft/Content/Assets/BlocksData.txt`.
`Survivalcraft/Block/BasaltBlock.cs` passes 40 to `PaintedCubeBlock`;
`PaintedCubeBlock.GetFaceTextureSlot` uses it for painted basalt. OpenVoxel's
`pale_basalt` uses this source artwork with a static warm gray multiplier
(0.82, 0.80, 0.76), following the source game's texture-times-palette mechanism.
This warm gray is an OpenVoxel art choice, not a Survivalcraft default palette entry.
It forms roads and locally weathered surfaces in exposed basalt terrain; their
underlying basalt retains source slot 6. The ordinary grass-covered area is unchanged.

Grass and leaves preserve authored RGB and multiply by the source climate palettes.
Oak, birch and poplar use the source species' autumn endpoint colors, with smooth
spatial timing variation. `environment/foliage/leaf.webp` is the unchanged
Survivalcraft `Content/Assets/Textures/LeafParticle.webp` used by `LeavesParticleSystem`.

OpenVoxel's generic `stone` and `granite` both use Survivalcraft granite,
the ordinary rock used for its underground terrain.
