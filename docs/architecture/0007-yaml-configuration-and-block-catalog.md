# ADR 0007：YAML 配置与共享方块目录

状态：已接受

## 裁决

OpenVoxel 的人工配置统一使用 YAML。服务应用配置由显式激活的 `@velarscript/server` 扩展负责严格、唯一键、别名与字节数有界的 YAML/JSON 加载，并立即通过 `OpenVoxelConfiguration` runtime type 验证；`@velarscript-labs/yaml` 只保留给 `packages/blocks` 的方块目录生成工具。OpenVoxel 不再维护服务端同义配置解析包装层，也不能让无类型 YAML 数据穿过应用边界。

`packages/blocks/data/blocks.yml` 是内置方块目录的唯一人工权威源。构建工具在 Node 环境中读取并验证它，生成静态的 `packages/blocks/generated/block-catalog.json`；生成物不是 VelarScript 源码。`@openvoxel/blocks` 通过自己的只读 `block-catalog-data` 子路径发布这份 JSON，类型校验和注册表逻辑仍由 `src/` 的手写代码拥有。服务端世界生成读取该产物，客户端未来通过服务端目录协议或该 JSON 子路径消费同一契约；不得再维护客户端枚举、服务端属性表或独立 UV 表。

YAML 中的方块定义分为三部分：

- 稳定身份：UInt16 `id`、命名空间 `key` 和翻译 key。
- 模拟语义：标签、碰撞、遮挡和流体类别。
- 渲染描述：形状、渲染层、材质以及逻辑纹理、模型、染色和动画 key。

渲染描述不能包含 Babylon.js 对象、UV 坐标、函数或资源文件系统路径。客户端资源层把逻辑 key 解析为图集区域、材质和模型实例。世界生成仍决定方块出现的位置；目录只描述方块自身，避免把生成算法变成一份不可维护的总配置。

## 身份与兼容性

- ID `0` 永远是 `openvoxel:air`。
- 已发布 ID 不重排、不复用；目录允许非连续 ID，删除定义时必须把数字写入 `retiredIds` 墓碑表。
- 注册表同时按 ID 与 key 建立索引，所有外部写入必须通过“已注册 ID”检查，不能只检查 UInt16 宽度。
- 生成工具分别计算只包含排序后 `{id,key}` 的 `blockIdMapHash`，以及覆盖完整规范化目录的 `contentHash`。前者保护存档解释，后者保护客户端资源缓存。`GET /api/blocks` 返回两者，联机客户端以服务器响应为运行时权威。
- 客户端本地 Worker 接入时必须从同一 JSON 构造注册表。未来加入资源包缓存时，以 `contentHash` 为缓存身份。

## 服务器配置

`apps/server/application.yml` 拥有监听地址、浏览器 CORS origin 白名单、HTTP/WebSocket 限额、SQLite 文件路径与连接结果限额。`@velarscript/server` 只按约定读取应用根目录的 `application.yml`；未显式激活该扩展时，这套配置不会生效。配置文件随服务包分发；所有相对路径以 `@openvoxel/server` 应用目录解析。VelarScript Server 启动器和 npm workspace 脚本将该目录设为进程工作目录；绕过这两个入口直接运行构建物时，部署方必须用绝对的 `OPENVOXEL_ROOT` 声明应用目录。`OPENVOXEL_CONFIG` 可以选择另一份显式 YAML/JSON 配置；`OPENVOXEL_HOST`、`OPENVOXEL_PORT`、`OPENVOXEL_LOGGER` 和 `OPENVOXEL_DB` 只作为部署覆盖层。机密值只允许环境或外部 secret store 注入，不进入应用配置。

协议版本、世界格式版本、生成器算法版本、SQL 表结构、外键约束和 WAL 模式不是部署偏好，仍由代码与架构裁决拥有。JSON 形式的 `package.json` 与 `velar.json` 是 npm 和 VelarScript 工具链清单，也不迁移为 YAML。

## 验证

`npm run generate` 显式更新方块目录 JSON；生成目录由 Git 排除，完整门禁会先重新生成，再由 `npm run generate:check` 验证结果。生成过程拒绝重复/退役 ID、重复 key、非法 UInt16、错误空气定义、重复标签、不完整纹理组合和无效模型描述。生成后的注册表测试同时固定目录哈希与 ID 映射哈希，并覆盖关键稳定 ID、标签索引、流体属性和未知/退役 ID 拒绝。`npm run structure:check` 额外拒绝放在 `tests/` 外的 `.test.vel`，以及任何出现在 `generated/` 中的 `.vel`。

## VelarScript 资源边界

OpenVoxel 统一使用 VelarScript 0.13。`@openvoxel/blocks` 在 `package.json#velar.resources` 中精确声明目录 JSON，并由 `catalog.vel` 使用 `import json` 读取为 `unknown`，随后立即通过 `BlockCatalogArtifact.parse` 建立受检查契约。工具链统一负责 `check`、`run`、`test`、`dev` 与 `build` 的资源解析、复制和测试沙箱子路径，因此不保留 Node 文件定位兼容层。
