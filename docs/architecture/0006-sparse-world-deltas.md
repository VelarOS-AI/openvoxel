# ADR 0006：生成世界与稀疏差异

状态：已接受

## 裁决

生成世界由 `seed + generator + ChunkPosition` 唯一决定，完整 Chunk 不写入数据库。持久化只保存：

- 世界清单中的种子、格式版本、Chunk 边长、生成器和完整世界方块注册表。
- 相对生成结果发生变化的方块状态运行时 ID。
- 修改过的 Chunk 的单调 revision。

`WorldRuntime` 同时依赖 `WorldManifestStore` 和 `WorldDeltaStore`。每个已加载世界拥有一个 `ActiveWorldState`：它用有界 LRU 缓存稀疏 Chunk 增量，共享同一 Chunk 的在途读取，并让查询复用当前 revision。固定地形不进入这个缓存。

## 写入规则

设置方块前，运行时先确认目标 UInt32 ID 存在于当前激活注册表和世界注册表，再读取该位置的生成值并计算可空覆盖：

- 目标值不同于生成值时，写入或更新一条覆盖。
- 目标值等于生成值时，删除已有覆盖。
- 目标覆盖与已存状态一致时，不写数据库，也不增加 revision。
- 真实变化时，运行时构造带 `expectedRevision` 的 `ChunkDeltaCommit`；完整 Chunk 批次在同一事务中提交。

同一世界的修改命令在运行时顺序化。存储成功后才替换热缓存并发布有序事件；存储失败时缓存保持原快照。SQLite 适配器只验证 revision、落盘变更和保证事务，不重复读取每个方块来推导业务结果。

即使一个 Chunk 的最后一条覆盖被删除，`chunk_states` 仍保留 revision。它是联机同步所需的修改历史元数据。

## SQLite 结构

`worlds.content_json` 保存精确 Content Pack 构建身份，`worlds.block_registry_json` 保存完整 `WorldBlockRegistrySnapshot`。`chunk_states` 以世界 ID 和 Chunk 坐标为复合主键，只保存 revision。`block_overrides` 在此基础上增加局部坐标复合主键，只保存 `block_state_runtime_id`。数据库没有完整 Chunk BLOB 表。

SQLite 适配器拥有一个长生命周期连接。批量 Chunk 查询使用一个坐标集合联表查询返回相关 revision 和覆盖；单方块变更使用一个事务原子比较、更新覆盖并推进 revision。

SQLite 与业务之间使用 `@velarscript-labs/database` 的参数化 command/query 层。世界表、注册表 JSON、动态 Chunk 坐标查询和 revision 事务属于 OpenVoxel 适配器。领域坐标始终作为对象传递，SQL 映射边界将其展开为列。

当前数据库 schema 为 5，由 `PRAGMA user_version` 标识。空库的三张表与 `user_version` 在一个事务中创建；读取世界时验证内容身份和注册表快照，恢复覆盖时验证 UInt32 数字范围。

## 取舍

当前使用规范化稀疏行，使单方块更新、删除和事务语义保持清楚。真实存档规模证明行模型成为瓶颈后，可以在不改变 `WorldDeltaStore` 的前提下替换 SQLite 内部编码。
