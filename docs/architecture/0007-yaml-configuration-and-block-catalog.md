# ADR 0007：YAML 定义与 JSON 方块产物

状态：已接受

## 裁决

人工数据与运行时数据分层存放：

- `packages/content/identities/data/identities.yml` 集中定义方块、标签、生成器、群系和资源身份。
- `packages/content/blocks/data/catalog.yml` 与 `data/blocks/*.yml` 只维护方块目录和方块定义。
- `packages/world/generation/data/catalog.yml`、`data/generators/*.yml` 与 `data/palettes/*.yml` 只维护地形算法参数、阶段规则和生成器方块绑定。
- 三个包分别把运行时 JSON 写入自己的 `generated/`，人工 YAML 与生成产物不在同一目录；`generated/` 由 Git 排除且不包含 `.vel` 源码。
- Mod 由 `@openvoxel/content` 从一份 `identities.yml`、可选方块目录和可选世界生成目录编译为独立构建目录中的唯一 `content-pack.json`。

各包的构建工具在 Node 环境中读取自己的 YAML，并通过 `@openvoxel/identities` 解析打点路径。`@openvoxel/blocks` 通过只读 `block-catalog-data` 子路径发布目录 JSON；运行时代码使用 `import json` 读取为 `unknown`，立即通过 `BlockCatalogArtifact.parse` 建立受检查契约。产物将重复组件归并为 `componentProfiles`，`states` 只保留属性和档案引用；模块装配时统一恢复完整状态。这样 `core`、Node、Web 和 Desktop 使用同一个同步资源入口，不各自实现 YAML 文件加载。

服务端世界生成、网络目录响应和未来浏览器 Worker 使用同一个编译目录。客户端不维护独立方块枚举、服务器属性表或资源需求表。

## 定义内容

YAML 中的方块类型包含：

- 身份：小写命名空间类型 key、翻译 key 和有限属性。
- 模拟语义：命名空间标签、物理、光照、交互和有类型行为组件。
- 渲染描述：逻辑模型、渲染层、材质、纹理、染色和动画 key。

内建方块文件只引用 `identities` 树中的真实打点路径：`key` 使用 `blocks.air`、`blocks.oakLog`，标签使用 `tags.terrain`、`tags.ore`、`tags.naturalRock`，渲染模型使用 `models.block.fluid`。每一段路径都直接对应 `identities.yml` 中的同名层级；解析规则就是身份树本身。行为中的 `supportingTag` 也直接引用 `tags.*`。规范状态键由路径指向的类型 key 与按属性名排序的完整属性集合构成。运行时 ID 不进入人工定义。渲染描述不包含引擎对象、UV 坐标、函数或资源文件系统路径。

世界生成目录以相同打点路径引用生成器、群系、地形类型和方块，但它的噪声参数、曲线、洞穴、矿物、植被与调色板都保存在 `packages/world/generation/data`。方块目录不读取地形配置，地形目录也不修改方块定义；二者只通过稳定身份和编译后的方块注册表相接。

## 生成身份

基础目录按规范状态键排序分配 UInt32 运行时 ID，`identities.blocks.air` 指定的状态固定为 0。生成器计算：

- `stateMapHash`：覆盖按运行时 ID 排序的全部 `{runtimeId,stateKey}`。
- `contentHash`：覆盖完整规范化目录，包括物理、光照、交互、行为和资源描述。

`GET /api/worlds/{worldId}/content` 返回该世界的内容哈希、状态映射哈希和紧凑组件档案。客户端以响应 ETag 缓存目录，并通过状态的 `componentProfileId` 取得最终组件。

运行时代码通过 `@openvoxel/identities` 的生成产物沿同一层级读取身份，例如 `builtinIdentities.blocks.air`、`builtinIdentities.tags.naturalRock` 和 `builtinIdentities.models.block.fluid`。实际身份值只写在 `identities.yml`；完整身份树以开放 `Record<unknown>` 保留并解析打点路径，只被 YAML 数据引用的新路径无需同步声明 VelarScript 字段。业务代码直接点访问的路径再投影为强类型 `BuiltinIdentities`，因此拼写错误仍在编译期或装配边界失败。生成器拒绝不存在的打点路径和未被引用的身份项，各目录编译器继续验证身份值与本包人工数据的语义。Mod 目录可以使用各自命名空间的标签。

## 服务器配置

`apps/server/application.yml` 拥有监听地址、浏览器 CORS origin 白名单、HTTP/WebSocket 限额、SQLite 文件路径与连接结果限额，并列出已安装 Content Pack JSON、默认 pack owner 和每世界活动 Chunk 缓存容量。运行时只读取已编译 JSON；`@velarscript-labs/yaml` 只在内容构建阶段使用。

`configuration(OpenVoxelConfiguration)` 只负责 YAML 语法和声明类型；环境变量转换与相对路径解析属于服务装配。监听器、实时会话、SQLite、Content Catalog 和 World Runtime 分别验证自己实际消费的参数与业务约束，配置模块不复制这些下游规则。

协议版本、世界格式、生成器算法和 SQL 表结构由代码与架构裁决拥有。`package.json` 与 `velar.json` 保持工具链要求的 JSON 格式。

## 验证

`npm run generate` 重建唯一的目录 JSON；`npm run generate:check` 从人工源重新计算并逐字验证当前产物。生成过程拒绝未知身份路径、闲置身份项、重复 key、非法 UInt32、错误空气定义、非法状态组合、重复标签或行为、无效物理/光照范围、不完整纹理组合和无效资源描述。

注册表测试固定基础目录、状态映射与内容哈希，并覆盖默认身份、状态转换、核心标签、行为和未知运行时 ID。`npm run structure:check` 拒绝位于 `tests/` 外的 `.test.vel`，以及任何出现在 `generated/` 中的 `.vel`。
