# ADR 0008：每世界方块注册表

状态：已接受

## 裁决

方块类型 key 与完整属性组合形成规范状态键，例如 `openvoxel:oak_log[axis=x]`。规范状态键是内容身份；UInt32 `runtimeId` 是一个世界内部用于 Chunk、稀疏覆盖和网络热路径的存储身份。

每个 `WorldManifest` 持久化完整 `WorldBlockRegistrySnapshot`：

- `formatVersion` 表示快照结构。
- `nextModRuntimeId` 是下一个 Mod 状态的分配位置。
- `states` 保存全部 `{runtimeId,stateKey}` 映射。

`openvoxel:air` 固定为运行时 ID 0。内建目录的状态使用 `0x00000000..0x00ffffff`。Mod 状态从 `0x01000000` 开始在每个世界中按规范状态键排序追加，因此 Mod 加载顺序不决定数字身份。

## Mod 目录合成

每个 Mod 通过 `BlockCatalogContribution` 提交：

- `owner`：拥有该命名空间的稳定 Mod 身份。
- `catalog`：与基础目录使用同一 schema 的编译方块目录。
- `stateAliases`：状态改名时显式声明的旧键到新键映射。

合成器验证命名空间所有权、目录 schema、规范状态键和重复定义。已有映射优先复用，新状态从 `nextModRuntimeId` 分配。未启用 Mod 的映射仍保留在世界快照并作为 `missingStates` 暴露；重新启用相同状态键时恢复原运行时 ID。显式别名把已有映射移动到新状态键。

## 运行时边界

`WorldBlockRegistry` 同时包含：

- 持久化快照，用于解释世界中的全部数字。
- 当前激活内容构造的 `BlockRegistry`，用于生成、模拟、渲染描述和新写入校验。
- `missingStates`，用于向客户端和工具报告缺少实现的世界映射。

Chunk 调色板存放世界运行时 ID，体素使用 UInt16 局部索引。一个 Chunk 最多容纳 65536 个不同状态，同时整个世界保留 UInt32 身份空间。

## 存储与协议

SQLite schema 3 将世界快照保存到 `worlds.block_registry_json`，覆盖保存到 `block_overrides.block_state_runtime_id`。世界 bootstrap 返回完整注册表；Chunk 响应返回 `palette` 与 `indices`；方块修改命令传递 `blockStateRuntimeId`。

## 强制验证

自动测试覆盖基础 ID 区间、Mod 高位分配、加载顺序确定性、缺失状态保留、重新启用恢复、显式别名、未知世界 ID 拒绝和高位 Mod 状态通过 Chunk 调色板往返。
