# ADR 0009：客户端接入契约边界

状态：已接受

## 裁决

客户端不维护独立的 API 路径、方块枚举、Chunk 布局、传输限额、错误码或渲染资源键。编译期契约是 `@openvoxel/protocol` 与 `@openvoxel/blocks`；运行时首先读取 `GET /api/client-contract`，再按世界读取 bootstrap 和方块目录。

`@openvoxel/protocol` 拥有全部路由常量，服务端路由注册和机器可读契约引用同一组常量。`clientContractVersion` 控制契约清单结构，`protocolVersion` 控制 HTTP/WebSocket 语义，`formatVersion` 控制世界和 Chunk 领域格式。

## 机器可读契约

`/api/client-contract` 发布：

- HTTP JSON 信封版本以及每个操作的 method/path。
- WebSocket 路径、MessagePack 编码、命令与事件名。
- Chunk 的 UInt32 世界运行时 ID 调色板、UInt16 局部索引、`x + edge * (z + edge * y)` 顺序和批量上限。
- 请求体、实时消息大小等部署限额。
- 基础方块目录的 schema、版本、状态映射哈希与内容哈希。
- capability 和公共错误码。

响应使用 `Cache-Control: no-store`。目录由强 ETag 独立缓存。世界 bootstrap 返回完整 `blockRegistry`、契约版本以及契约、目录、实时通道的路径。

## 渲染资源边界

方块 YAML 只保存逻辑资源 key。`GET /api/blocks` 从权威目录确定性聚合并排序 materials、textures、models、tints 和 animations。

客户端资源包完整覆盖这些逻辑 key；具体 key 到纹理图集、着色器和模型文件的映射属于客户端资源包。客户端不维护另一份手写资源需求清单。

## 浏览器与错误语义

浏览器允许来源进入 `apps/server/application.yml`。HTTP 与 WebSocket 使用同一 origin 白名单，两种传输都不启用凭据型跨域。

客户端按稳定 `code` 分支。VelarScript 解析、JSON 解码和收窄错误统一为 `InvalidRequest`；超限请求归一为 `PayloadTooLarge`；未知服务器错误归一为 `InternalError` 并隐藏内部细节。

## 演进规则

- 增加操作时，同步更新路由常量、capability、共享类型、服务端测试和协议文档。
- 改变现有字段含义、MessagePack 消息或 Chunk 编码时更新 `protocolVersion` 及全部消费者。
- 改变 client-contract 字段结构时更新 `clientContractVersion` 及全部消费者。
- 改变世界存储结构时更新当前 schema、领域类型、适配器和测试。
- 玩家会话、鉴权、移动、物品和冲突合并进入实现后再加入契约。
