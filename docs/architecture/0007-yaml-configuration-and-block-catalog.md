# ADR 0007：YAML 配置与共享方块目录

状态：已接受

## 裁决

OpenVoxel 的人工配置统一使用 YAML。`@openvoxel/config` 通过 `yaml` npm 包提供唯一的受检查解析边界，具体模块仍必须使用自己的 VelarScript runtime type 验证解析结果，不能让无类型 YAML 数据穿过应用边界。

`packages/blocks/data/blocks.yml` 是内置方块目录的唯一人工权威源。构建工具在 Node 环境中读取并验证它，生成跨目标的 `src/generated.vel`。服务端、世界生成、浏览器单机 Worker 和客户端渲染都消费 `@openvoxel/blocks`；不得再维护客户端枚举、服务端属性表或独立 UV 表。

YAML 中的方块定义分为三部分：

- 稳定身份：UInt16 `id`、命名空间 `key` 和翻译 key。
- 模拟语义：标签、碰撞、遮挡和流体类别。
- 渲染描述：形状、渲染层、材质以及逻辑纹理、模型、染色和动画 key。

渲染描述不能包含 Babylon.js 对象、UV 坐标、函数或资源文件系统路径。客户端资源层把逻辑 key 解析为图集区域、材质和模型实例。世界生成仍决定方块出现的位置；目录只描述方块自身，避免把生成算法变成一份不可维护的总配置。

## 身份与兼容性

- ID `0` 永远是 `openvoxel:air`。
- 已发布 ID 不重排、不复用；目录允许非连续 ID。
- 注册表同时按 ID 与 key 建立索引，所有外部写入必须通过“已注册 ID”检查，不能只检查 UInt16 宽度。
- 生成工具对规范化目录计算 SHA-256。`GET /api/blocks` 返回 `schemaVersion`、`catalogVersion` 和 `contentHash`，联机客户端以服务器响应为运行时权威。
- 本地 Worker 直接使用同一生成注册表。未来加入资源包缓存时，以 `contentHash` 为缓存身份。

## 服务器配置

`apps/server/config/server.yml` 拥有监听地址、HTTP/WebSocket 限额、SQLite 文件路径与连接结果限额。`OPENVOXEL_CONFIG` 可以选择另一份 YAML；`OPENVOXEL_HOST`、`OPENVOXEL_PORT`、`OPENVOXEL_LOGGER` 和 `OPENVOXEL_DB` 只作为部署覆盖层。

协议版本、世界格式版本、生成器算法版本、SQL 表结构、外键约束和 WAL 模式不是部署偏好，仍由代码与架构裁决拥有。JSON 形式的 `package.json` 与 `velar.json` 是 npm 和 VelarScript 工具链清单，也不迁移为 YAML。

## 验证

`npm run generate` 在完整门禁前重新生成方块注册表。生成过程拒绝重复 ID/key、非法 UInt16、错误空气定义、重复标签、不完整纹理组合和无效模型描述。生成后的注册表测试同时覆盖目录版本、内容哈希、关键稳定 ID、标签查询、流体属性和未知 ID 拒绝。
