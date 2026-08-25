# 第一课：先证明世界能够活下来

第一阶段不渲染方块。它先回答一个更基础的问题：一个世界能否被创建、生成、修改、保存、重启和同步？

学习顺序：

1. 从 `packages/world/src/spatial/coordinates.vel` 理解负坐标和三维 Chunk。
2. 从 `packages/world/src/chunk/chunk.vel` 理解 UInt32 世界运行时 ID 调色板、定长 `UInt16Buffer` 局部索引和内存布局。
3. 从 `packages/world-generation/src/generator-registry.vel` 和 `src/survival/generator.vel` 理解生成器身份与确定性流水线。
4. 从 `packages/world-runtime/src/world-runtime.vel` 理解用例如何每次重建基础 Chunk，再叠加稀疏差异。
5. 对比内存和 SQLite 两个 `WorldDeltaStore` 实现，再阅读 `sqlite-world-store.vel` 中的 command/query 操作，观察业务 SQL 如何通过通用执行器只保存修改数据。
6. 从 `apps/server/src/server.vel` 理解应用如何组合原生 HTTP/WebSocket、错误处理和生命周期。
7. 最后阅读 `apps/server/src/modules`，观察 HTTP 与 WebSocket 如何进入同一套用例。

运行 `npm test` 会分别证明世界模型不变量、生成确定性、运行时恢复、未修改 Chunk 不落盘、SQLite 稀疏覆盖重开、原生 ServeApp 路由以及真实 HTTP/WebSocket 链路。只有这些事实稳定后，渲染器才有值得显示的数据。
