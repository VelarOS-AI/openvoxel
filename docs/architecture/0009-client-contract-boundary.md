# ADR 0009：客户端接入契约边界

状态：已接受

## 裁决

客户端以 `@openvoxel/protocol` 取得线上数据类型，以 `GET /api`、世界 bootstrap、每世界内容目录和 OpenAPI 取得当前服务实例事实。

`@openvoxel/protocol` 拥有线上数据结构、消息名称、编码、公共错误身份和协议版本。HTTP 路径直接写在 `apps/server` 的路由注解中，框架从这些注解生成 OpenAPI 3.1；客户端和文档工具不再维护第二份 method/path 字符串表。`clientContractVersion` 控制接入清单结构，`protocolVersion` 控制 HTTP 与 WebSocket 语义，世界 `formatVersion` 控制持久化领域格式。

协议包不读取方块目录、生成器、世界运行时或部署配置。`apps/server/src/presentation` 把当前进程中的固定地形、热增量、地形采样、世界清单、方块目录和传输限额投影成协议类型，因此客户端引用协议类型时不会把服务端执行系统带入依赖图。

## 机器可读入口

`GET /api` 发布：

- HTTP JSON 和 MessagePack 实时编码。
- OpenAPI 3.1 描述格式。
- `chunks.sync`、`blocks.apply` 及对应事件名。
- Chunk 的 UInt32 世界运行时 ID 调色板、UInt16 局部索引、索引顺序和批量上限。
- 请求体、实时消息大小等部署限额。
- capability 和公共错误码。

`GET /api/openapi.json` 是 HTTP 操作、路径参数、请求体、必选性和响应状态的权威机器描述。`GET /api/worlds/{worldId}/content` 使用强 ETag 独立缓存。世界 bootstrap 返回完整 `blockRegistry`、内容状态映射哈希、生成器哈希和读取 Chunk 前需要校验的服务事实。

## 冷热数据边界

HTTP 的地形 Chunk 只由种子、生成器定义和世界方块注册表决定。客户端通过世界下的批量 terrain 资源读取它，并可以按生成器哈希缓存。

WebSocket 路径把连接绑定到一个世界。客户端通过 `chunks.sync` 读取 revision 与稀疏覆盖，通过 `blocks.apply` 原子提交批量修改。请求方收到 `blocks.applied` 确认；同世界订阅者收到不含玩家 requestId 的 `blocks.changed` 有序事实。流体 Tick、玩家移动、物品和战斗等后续热系统也沿这条世界会话边界扩展。

`@openvoxel/client` 是传输无关的客户端应用层。它把固定地形压入 `UInt16Buffer`，
用稀疏覆盖组合当前 Chunk，校验协议、内容与生成器身份，并统一拥有 requestId、
连接代际、sequence、revision、多批次同步和重连期间的广播暂存。浏览器在线适配器
和后续 Worker 本地适配器都实现同一个 `WorldBackend`，不复制冷热合并状态机。

`@openvoxel/client-web` 实现浏览器 `OnlineBackend`。调用方只交给它 OpenAPI URL；
它按协议包集中定义的 operationId 发现 HTTP 与 WebSocket 地址，启动时缓存发现结果，
之后用 JSON 拉取冷数据、用 MessagePack 处理同世界热事件。客户端源码不保存任何
`/api/worlds/...` 路径副本，服务端改路径后只要操作身份和数据语义不变就无需改客户端。

## HTTP 返回与错误

成功路由直接返回资源数据或框架的 `respond`、`created` 等原生响应对象，由内容协商选择表示。HTTP 错误统一使用 `application/problem+json`，稳定 `code` 供客户端分支，HTTP status 表达传输结果，未知内部错误不公开栈和实现细节。

WebSocket 错误使用 MessagePack `error` 事件，并在能够读取时回显 `requestId`。连接内命令不允许重新声明世界身份。

## 渲染资源边界

方块 YAML 只保存逻辑资源 key。`GET /api/worlds/{worldId}/content` 从该世界权威目录确定性聚合并排序 materials、textures、models、tints 和 animations。

客户端资源包完整覆盖这些逻辑 key；具体 key 到纹理图集、着色器和模型文件的映射属于客户端资源包。客户端不维护另一份手写资源需求清单。

## 演进规则

- 增加对外操作时修改实际路由与共享数据类型，为路由声明唯一 operationId，并检查生成的 OpenAPI。
- 改变现有字段含义、MessagePack 消息或 Chunk 编码时更新 `protocolVersion` 及全部消费者。
- 改变 API 根契约字段结构时更新 `clientContractVersion` 及全部消费者。
- 改变世界存储结构时更新当前 schema、领域类型、适配器和测试。
- 每条世界写命令必须有明确批量上限、完整预验证、事务边界和广播范围。
