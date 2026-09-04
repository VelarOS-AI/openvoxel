# Reference asset sources

These source images are build inputs for the OpenVoxel client resource pack. They are kept behind the renderer resource contract; runtime code only consumes generated artifacts.

| File | Local source project | Original path | SHA-256 |
| --- | --- | --- | --- |
| `survivalcraft-blocks.webp` | Survivalcraft reference project | `/Users/mac/Documents/ChatGPT/我的世界/minecraft-master/src/game-root/assets/blocks/Blocks.webp` | `1f1f071a557ca8dcdedf3239d89817c9ce394a1373368533ad5cafecc717cfd7` |
| `openworld-clouds.webp` | OpenWorld reference project | `/Users/mac/Documents/ChatGPT/我的世界/minecraft-master/src/engine/environment/assets/Clouds.webp` | `a06508f24dcebaeaa5909f2f9df7812d84f80dccc7af136e1d4fb87135cb9662` |

The generator selects declared atlas cells, combines optional OpenVoxel detail layers, and derives aligned normal and specular maps. It does not copy source-project runtime code or block-number mappings.

Asset ownership and redistribution permission must be confirmed separately before a public release; the build does not infer a license from the source repository.
