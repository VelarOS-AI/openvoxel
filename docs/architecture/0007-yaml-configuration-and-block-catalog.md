# ADR 0007：YAML 定义与 JSON 方块产物

状态：已接受

## 裁决

人工数据与运行时数据分层存放：

- `packages/blocks/data/identities.yml` 集中定义内建方块 key、核心标签、生成器和运行时代码引用的资源身份。
- `packages/blocks/data/catalog.yml` 与 `data/blocks/*.yml` 是人工维护的目录和方块定义，目录版本也以 `catalogs.base` 直接引用身份树。
- `packages/blocks/generated/block-catalog.json` 是唯一运行时产物，包含身份、紧凑编译目录和基础状态映射。
- `generated/` 由 Git 排除，只存放工具可以重建的 JSON 产物，不包含 `.vel` 源码。

构建工具在 Node 环境中读取 YAML，合并并验证所有源文件，然后生成一份 JSON。`@openvoxel/blocks` 通过只读 `block-catalog-data` 子路径发布目录 JSON；运行时代码使用 `import json` 读取为 `unknown`，立即通过 `BlockCatalogArtifact.parse` 建立受检查契约。产物将重复组件归并为 `componentProfiles`，`states` 只保留属性和档案引用；模块装配时统一恢复完整状态。这样 `core`、Node、Web 和 Desktop 使用同一个同步资源入口，不各自实现 YAML 文件加载。

服务端世界生成、网络目录响应和未来浏览器 Worker 使用同一个编译目录。客户端不维护独立方块枚举、服务器属性表或资源需求表。

## 定义内容

YAML 中的方块类型包含：

- 身份：小写命名空间类型 key、翻译 key 和有限属性。
- 模拟语义：命名空间标签、物理、光照、交互和有类型行为组件。
- 渲染描述：逻辑模型、渲染层、材质、纹理、染色和动画 key。

内建方块文件只引用 `identities` 树中的真实打点路径：`key` 使用 `blocks.air`、`blocks.oakLog`，标签使用 `tags.terrain`、`tags.ore`、`tags.naturalRock`，渲染模型使用 `models.block.fluid`。每一段路径都直接对应 `identities.yml` 中的同名层级；生成器逐层读取该位置，解析规则就是 `identities` 树本身。行为中的 `supportingTag` 也直接引用 `tags.*`。规范状态键由路径指向的类型 key 与按属性名排序的完整属性集合构成。运行时 ID 不进入人工定义。渲染描述不包含引擎对象、UV 坐标、函数或资源文件系统路径。

## 生成身份

基础目录按规范状态键排序分配 UInt32 运行时 ID，`identities.blocks.air` 指定的状态固定为 0。生成器计算：

- `stateMapHash`：覆盖按运行时 ID 排序的全部 `{runtimeId,stateKey}`。
- `contentHash`：覆盖完整规范化目录，包括物理、光照、交互、行为和资源描述。

`GET /api/blocks` 返回两种哈希和同一份紧凑组件档案。客户端以 `contentHash` 缓存目录，以 `stateMapHash` 识别基础状态映射，并通过状态的 `componentProfileId` 取得最终组件。每世界 Mod 身份由世界方块注册表负责。

运行时代码通过生成产物中的 `builtinIdentities` 沿同一层级读取身份，例如 `builtinIdentities.blocks.air`、`builtinIdentities.tags.naturalRock` 和 `builtinIdentities.models.block.fluid`。实际身份值只写在 `identities.yml`；完整身份树以开放 `Record<unknown>` 保留并解析打点路径，只被 YAML 数据引用的新路径无需同步声明 VelarScript 字段。业务代码直接点访问的路径再投影为强类型 `BuiltinIdentities`，因此拼写错误仍在编译期或装配边界失败。生成器拒绝不存在的打点路径和未被引用的身份项，编译器继续验证身份值与人工方块目录的语义。Mod 目录可以使用各自命名空间的标签。

## 服务器配置

`apps/server/application.yml` 拥有监听地址、浏览器 CORS origin 白名单、HTTP/WebSocket 限额、SQLite 文件路径与连接结果限额。`@velarscript/server` 负责应用配置加载，`@velarscript-labs/yaml` 只用于方块目录生成。机密值由部署环境或外部 secret store 注入。

协议版本、世界格式、生成器算法和 SQL 表结构由代码与架构裁决拥有。`package.json` 与 `velar.json` 保持工具链要求的 JSON 格式。

## 验证

`npm run generate` 重建唯一的目录 JSON；`npm run generate:check` 从人工源重新计算并逐字验证当前产物。生成过程拒绝未知身份路径、闲置身份项、重复 key、非法 UInt32、错误空气定义、非法状态组合、重复标签或行为、无效物理/光照范围、不完整纹理组合和无效资源描述。

注册表测试固定基础目录、状态映射与内容哈希，并覆盖默认身份、状态转换、核心标签、行为和未知运行时 ID。`npm run structure:check` 拒绝位于 `tests/` 外的 `.test.vel`，以及任何出现在 `generated/` 中的 `.vel`。
