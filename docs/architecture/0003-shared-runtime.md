# ADR 0003：共享运行时与适配器

状态：已接受

`@openvoxel/world-runtime` 是客户端面对的统一应用接口。它依赖 `@openvoxel/world` 的世界模型、`@openvoxel/world-generation` 的生成器入口、`@openvoxel/blocks` 的每世界注册表，以及由 `WorldManifestStore`、`WorldDeltaStore` 组成的 `WorldStore` 端口；它不知道 SQLite、IndexedDB、HTTP 或 WebSocket。清单存储拥有世界种子、生成器身份与方块状态映射；差异存储只拥有修改过的方块和 Chunk revision。

Node 联机组合使用 SQLite：

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

浏览器单机组合复用同一个 `WorldRuntime`，只替换存储和调用适配器：

```text
LocalBackend
     ↓
Dedicated Browser Worker
     ↓
WorldRuntime
     ↓
IndexedDB WorldStore
```

`@openvoxel/client-local` 的主线程部分只拥有类型化 Worker 客户端和事件泵。专用 Worker 拥有 `WorldRuntime`、活动世界缓存、连接租约和每连接最多 256 条的事件队列；Worker RPC 串行执行，因此事件读取采用短促的非阻塞轮询，不用一个长期等待占住后续 Chunk 同步和写命令。队列溢出会终止该连接语义并要求会话重连。

IndexedDB 适配器把世界清单保存为受 `WorldManifest` 检查的规范 JSON，把 Chunk revision 与稀疏覆盖保存为 MessagePack `Bytes`。一次方块命令的全部 Chunk 变化先验证 expected revision，再通过 `database.batch` 在同一个 IndexedDB 事务中发布。一个 LocalBackend 的专用 Worker 是当前单机实例的唯一 writer；多个页面实例同时修改同一个数据库不属于这份单实例事务契约。

这条边界保证单机和联机不是两套游戏逻辑。查询 Chunk 时，两种模式都先运行相同生成器，再叠加各自差异存储返回的覆盖。Node/Web 特有模块只能出现在 `apps/*` 或明确的适配器包中。
