# 第一课：先证明世界能够活下来

第一阶段不渲染方块。它先回答一个更基础的问题：一个世界能否被创建、生成、修改、保存、重启和同步？

学习顺序：

1. 从 `packages/domain/src/coordinates.vel` 理解负坐标和三维 Chunk。
2. 从 `packages/domain/src/chunk.vel` 理解定长 `UInt16Buffer` 和内存布局。
3. 从 `packages/domain/src/generator.vel` 理解种子如何产生确定性世界。
4. 从 `packages/world-runtime/src/world-runtime.vel` 理解用例如何每次重建基础 Chunk，再叠加稀疏差异。
5. 对比内存和 SQLite 两个 `WorldDeltaStore` 实现，观察相同端口如何只保存修改数据。
6. 从 `packages/backend/src/index.vel` 理解应用如何隔离 Fastify。
7. 最后阅读 `apps/server/src/modules`，观察 HTTP 与 WebSocket 如何进入同一套用例。

运行 `npm test` 会依次证明坐标属性、生成确定性、运行时恢复、未修改 Chunk 不落盘、SQLite 稀疏覆盖重开、Fastify 路由注入以及真实 HTTP/WebSocket 链路。只有这些事实稳定后，渲染器才有值得显示的数据。
