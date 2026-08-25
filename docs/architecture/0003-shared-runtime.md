# ADR 0003：共享运行时与适配器

状态：已接受

`@openvoxel/world-runtime` 是客户端面对的统一应用接口。它依赖 `@openvoxel/world` 的世界模型、`@openvoxel/world-generation` 的生成器入口、`@openvoxel/blocks` 的每世界注册表，以及由 `WorldManifestStore`、`WorldDeltaStore` 组成的 `WorldStore` 端口；它不知道 SQLite、IndexedDB、HTTP 或 WebSocket。清单存储拥有世界种子、生成器身份与方块状态映射；差异存储只拥有修改过的方块和 Chunk revision。

当前 Node 组合使用 SQLite：

```text
HTTP / WebSocket
       ↓
WorldRuntime
       ↓
WorldManifestStore + WorldDeltaStore
       ↓
OpenVoxel operations + schema
       ↓
@velarscript-labs/database executor
       ↓
@velarscript-labs/sqlite
```

未来浏览器单机组合复用同一个 `WorldRuntime`，只替换存储和调用适配器：

```text
LocalBackend
     ↓
Browser Worker
     ↓
WorldRuntime
     ↓
Memory / IndexedDB
```

这条边界保证单机和联机不是两套游戏逻辑。查询 Chunk 时，两种模式都先运行相同生成器，再叠加各自差异存储返回的覆盖。Node/Web 特有模块只能出现在 `apps/*` 或明确的适配器包中。
