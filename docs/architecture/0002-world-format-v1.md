# ADR 0002：世界格式 v1

状态：已接受

## Chunk

- Chunk 永远是正方体。
- 世界清单保存 `chunkEdge`，当前格式固定为 `16 × 16 × 16`，每个 Chunk 有 4096 个体素。
- Chunk 持有一个 UInt32 方块状态运行时 ID 调色板；每个体素使用 UInt16 局部索引指向该调色板。
- 调色板第几项没有跨 Chunk 身份含义。方块语义来自 `palette[indices[index]]` 得到的世界运行时 ID。
- 内存布局是 `x + edge * (z + edge * y)`，x 连续、其次 z、最后 y。
- 完整 Chunk 是由生成器重建的瞬态数据，不进入持久化格式。

## 世界方块注册表

每个 `WorldManifest` 持有完整 `blockRegistry` 快照。注册表把规范状态键映射到 UInt32 运行时 ID：内建状态使用固定基础区间，Mod 状态从 `0x01000000` 开始按世界追加。Chunk、覆盖和网络消息中的运行时 ID 都以目标世界的注册表解释。

注册表保留暂时缺少内容实现的映射，使世界结构仍能被读取；只有当前激活目录中存在的状态可以进入新的方块写入。Mod 改名通过显式状态别名把已有映射移动到新规范状态键。

## 坐标

水平坐标由 `Coordinate2 {x, z}` 定义，`Coordinate3` 在此基础上继承 `y`。`ChunkPosition`、`LocalPosition` 和 `BlockPosition` 是 `Coordinate3` 的语义别名。

领域、运行时和网络协议始终传递 `position` 对象。只有 SQLite 列和噪声数学内核在各自边界读取标量分量。世界坐标到 Chunk 坐标使用向下取整，因此 `-1` 属于 Chunk `-1` 的局部坐标 `15`。

## 版本与修订

- `formatVersion` 控制当前磁盘和领域格式，值为 1。
- `generator` 固定为 `openvoxel:survival-v1`。
- 可生成世界高度为 `0..255`，海平面为 64。
- 每个 Chunk 独立维护 `revision`，只有方块值真实变化时递增。
- 持久化只记录相对生成结果的方块覆盖；方块恢复为生成值时删除覆盖。
- 网络变更事件携带修改后的 revision，客户端据此识别过期状态。
