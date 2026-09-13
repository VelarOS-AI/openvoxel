# ADR 0006：生成世界与稀疏差异

状态：已接受

## 裁决

生成世界由 `seed + generator + ChunkPosition` 唯一决定，完整 Chunk 不写入数据库。持久化只保存：

- 世界清单中的种子、格式版本、Chunk 边长、生成器和完整世界方块注册表。
- 玩家拥有的稀疏方块状态运行时 ID；可生长作物同时保存其生态时间锚点。
- 修改过的 Chunk 的单调 revision。

`WorldRuntime` 同时依赖 `WorldManifestStore` 和 `WorldDeltaStore`。每个已加载世界拥有一个 `ActiveWorldState`：它用有界 LRU 缓存稀疏 Chunk 增量，共享同一 Chunk 的在途读取，并让查询复用当前 revision。固定地形不进入这个缓存。

存储与热缓存的类型为 `StoredChunkDelta`，只包含玩家覆盖及其内部演化锚点。查询层返回不暴露锚点的 `WorldChunkSnapshot`，带有明确的 `ecologyEpoch`，按固定地形、自然冰雪与作物阶段、玩家覆盖的顺序组合可见世界。快照可以共享缓存中的只读覆盖列表，生态时间槽由查询拥有。

## 写入规则

设置方块前，运行时先确认目标 UInt32 ID 存在于当前激活注册表和世界注册表，再读取该位置的生成值并计算可空覆盖：

- 目标值不同于生成值时，写入或更新一条覆盖。
- 非生态位置恢复生成值时删除覆盖；自然生态位置写回同一可见值时仍可记录玩家所有权，避免后续时间槽把它覆盖。
- 新种植或显式重置作物时记录当前生态时间槽；重复提交同一可见与内部状态时不写数据库，也不增加 revision。
- 真实变化时，运行时构造带 `expectedRevision` 的 `ChunkDeltaCommit`；完整 Chunk 批次在同一事务中提交。

同一世界的修改命令在运行时顺序化。存储成功后才替换热缓存并发布有序事件；存储失败时缓存保持原快照。内部所有权或生长锚点只推进持久化 `storageRevision`；只有可见方块状态真正改变才推进公开 `revision` 和事件 `sequence`。因此内部写入不会制造伪世界事件，也不会使客户端看到版本断层。SQLite 适配器验证内部版本的乐观并发条件，并保证整批事务，不重复推导业务结果。

即使一个 Chunk 的最后一条覆盖被删除，`chunk_states` 仍保留 revision。它是联机同步所需的修改历史元数据。

## SQLite 结构

`worlds.content_json` 保存精确 Content Pack 构建身份，`worlds.block_registry_json` 保存完整 `WorldBlockRegistrySnapshot`。`chunk_states` 以世界 ID 和 Chunk 坐标为复合主键，保存公开 `revision` 和内部 `storage_revision`。`block_overrides` 在此基础上增加局部坐标复合主键，保存 `block_state_runtime_id` 和可空的 `growth_origin_epoch`。数据库没有完整 Chunk BLOB 表。

SQLite 适配器拥有一个长生命周期连接。批量 Chunk 查询使用一个坐标集合联表查询返回相关 revision 和覆盖；单方块变更使用一个事务原子比较、更新覆盖并推进 revision。

SQLite 与业务之间使用 `@velarscript-labs/database` 的参数化 command/query 层。世界表、注册表 JSON、动态 Chunk 坐标查询和 revision 事务属于 OpenVoxel 适配器。领域坐标始终作为对象传递，SQL 映射边界将其展开为列。

当前数据库 schema 为 9，由 `PRAGMA user_version` 标识。空库的三张表与 `user_version` 在一个事务中创建；`worlds.climate_json` 保存与生成器一致的基础气候参数。读取世界时验证游戏模式、世界时间原点、气候参数、内容身份和注册表快照，恢复覆盖时验证 UInt32 数字范围以及非负生态时间槽。格式不匹配时明确拒绝打开，保持原数据库不变。

## 取舍

当前使用规范化稀疏行，使单方块更新、删除和事务语义保持清楚。真实存档规模证明行模型成为瓶颈后，可以在不改变 `WorldDeltaStore` 的前提下替换 SQLite 内部编码。
