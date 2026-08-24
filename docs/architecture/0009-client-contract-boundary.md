# ADR 0009：客户端接入契约边界

状态：已接受

## 裁决

未来客户端不维护独立的 API 路径、方块枚举、Chunk 布局、传输限额、错误码或渲染资源键。编译期唯一契约是 `@openvoxel/protocol` 与 `@openvoxel/blocks`；运行时首先读取 `GET /api/client-contract`，再按世界读取 `GET /api/worlds/:worldId/bootstrap` 和 `GET /api/blocks`。

`@openvoxel/protocol` 拥有全部稳定路由常量，服务端路由注册和机器可读契约都引用这些常量，禁止在两处复制路径。`clientContractVersion` 只控制契约清单自身的结构，`protocolVersion` 控制 HTTP/WebSocket 语义，`formatVersion` 控制世界和 Chunk 领域格式，三者不得混用。

## 机器可读契约

`/api/client-contract` 发布以下事实：

- HTTP JSON 信封版本以及每个稳定操作的 method/path。
- WebSocket 路径、MessagePack 编码、当前命令与事件名。
- Chunk 的 UInt16 列表表示、`x + edge * (z + edge * y)` 索引顺序和批量上限。
- 请求体、实时消息大小等实际部署限额。
- 当前方块目录的 schema、版本、ID 映射哈希与完整内容哈希。
- 可选 capability 和稳定公共错误码。

响应使用 `Cache-Control: no-store`，因为部署限额可以随服务实例变化。目录仍由强 ETag 独立缓存。世界 bootstrap 同时返回契约版本及契约、目录、实时通道的相对路径，使一个世界的启动检查自包含。

## 渲染资源边界

方块 YAML 继续只保存逻辑资源 key，不保存图集 UV、引擎对象或物理文件路径。`GET /api/blocks` 除逐方块渲染描述外，还发布从权威目录确定性聚合并排序的 `resources`：materials、textures、models、tints 和 animations。

未来客户端资源包必须完整覆盖这些逻辑 key；具体 key 到纹理图集、着色器和模型文件的映射属于客户端资源包，不能反向进入服务器方块定义。聚合集合由服务端生成，客户端不得维护另一份手写“需要哪些资源”的清单。

## 浏览器与错误语义

浏览器允许来源进入 `apps/server/config/server.yml`。服务端仅允许配置中的 origin，HTTP 允许 `content-type` 与 `if-none-match` 请求头并暴露 `etag` 与协议版本响应头；WebSocket upgrade 也校验同一 origin 白名单。两种传输都不启用凭据型跨域。

客户端只能按稳定 `code` 分支，不能匹配 `message`。VelarScript 解析、JSON 解码和收窄错误统一为 `InvalidRequest`；超限请求归一为 `PayloadTooLarge`，不得把原生宿主内部错误名变成公共协议。未知服务器错误统一为 `InternalError` 且隐藏内部细节。

## 演进规则

- 新增向后兼容操作时，同时增加路由常量、capability、共享类型、服务端测试和协议文档。
- 改变现有字段含义、MessagePack 消息语义或 Chunk 编码时提升 `protocolVersion`。
- 改变 client-contract 的字段结构时提升 `clientContractVersion`。
- 改变方块数字 ID/key 对应关系时使用新目录版本与 ID 映射哈希，并提供显式世界迁移或拒绝加载。
- 玩家会话、鉴权、移动、物品和冲突合并尚不属于当前契约，不得提前发布占位 capability。
