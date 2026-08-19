# ADR 0006：生成世界与稀疏差异

状态：已接受

## 裁决

生成世界是由 `seed + generator + ChunkPosition` 唯一决定的可重建数据，完整 Chunk 永远不写入数据库。持久化只保存：

- 世界清单中的种子、格式版本、Chunk 边长和生成器版本。
- 相对生成结果发生变化的方块覆盖。
- 修改过的 Chunk 的单调 revision。

`WorldRuntime` 同时依赖 `WorldManifestStore` 和 `WorldDeltaStore`。查询一个或一批 Chunk 时，它只读取一次世界清单，确定性生成基础缓冲区，再按 Chunk 叠加存储返回的覆盖。SQLite 与未来浏览器适配器必须实现相同语义。

## 写入规则

设置方块前，运行时直接从生成器读取该位置的基础值，并把目标值转换成可空覆盖：

- 目标值不同于基础值时，写入或更新一条覆盖。
- 目标值等于基础值时，删除已有覆盖。
- 目标覆盖与已存状态一致时，不写数据库，也不增加 revision。
- 真实变化时，覆盖修改和 revision 增长必须在同一事务中提交。

即使一个 Chunk 的最后一条覆盖被删除，`chunk_states` 仍保留 revision。它不是生成数据，而是联机同步和未来乐观并发控制所需的修改历史元数据。

## SQLite 结构

`chunk_states` 以世界 ID 和 Chunk 坐标为复合主键，只保存 revision。`block_overrides` 在此基础上增加局部坐标复合主键，只保存方块 ID。数据库没有完整 Chunk BLOB 表。

SQLite 适配器拥有一个长生命周期连接。批量 Chunk 查询使用一个带坐标集合的联表查询返回全部相关 revision 和覆盖；单方块变更使用一个事务原子比较、更新覆盖并推进 revision。同一连接的操作通过应用层 `async-mutex` 窄桥排队，避免 HTTP 并发请求插入活动事务；这项并发能力不进入 VelarScript 标准库。领域坐标始终作为对象传递，只有 SQL 映射边界把它展开为列。

## 取舍

第一版使用规范化稀疏行，而不是自研压缩补丁 BLOB。它让教学读者能直接检查状态，也让单方块更新、删除和事务语义保持清楚。只有真实存档规模证明行模型成为瓶颈时，才在不改变 `WorldDeltaStore` 的前提下替换 SQLite 内部编码。
