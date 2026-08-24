# OpenVoxel 协议 v1

所有 HTTP JSON 请求最大 64 KiB。世界与 Chunk 的领域格式版本由世界清单中的 `formatVersion` 表示；传输协议版本由健康检查中的 `protocolVersion` 表示。

## HTTP

所有 HTTP 响应使用同一个信封：

```json
{"code":"OK","data":{},"message":"success"}
```

- `code` 是稳定的字符串业务码；成功通常为 `OK`，创建成功为 `CREATED`。客户端只能按 `GET /api/client-contract` 发布的错误码分支，不能依赖传输宿主或 VelarScript 的内部错误名。
- `data` 保存业务数据；没有错误详情时为 `null`。
- `message` 是供人阅读的说明，客户端分支必须读取 `code`，不能匹配文案。
- HTTP status 仍表达传输结果，不重复塞进 JSON 字段。

### `GET /api/health`

```json
{"code":"OK","data":{"status":"ready","service":"openvoxel","protocolVersion":1},"message":"success"}
```

### `GET /api/client-contract`

客户端接入的机器可读入口。它返回 `clientContractVersion`、`protocolVersion`、全部稳定 HTTP method/path、WebSocket 编码和消息名、Chunk 的 UInt16 列表与 `x + edge * (z + edge * y)` 索引顺序、传输限额、capability、公共错误码和当前方块目录身份。

该响应使用 `Cache-Control: no-store`，因为请求体和实时消息上限属于具体服务实例。VelarScript 客户端同时直接依赖 `@openvoxel/protocol` 获得精确类型；其他语言以该响应和本文档为准，不自行猜测路由。

### `GET /api/blocks`

返回 `openvoxel:survival-v1` 的世界高度、海平面和完整方块目录。目录携带 `schemaVersion`、`catalogVersion`、只覆盖稳定 ID/key 对应关系的 `idMapHash`，以及覆盖全部模拟与渲染描述的 `contentHash`。每个方块同时包含稳定 ID、key、标签、模拟属性和声明式渲染描述。`resources` 从目录确定性聚合并排序，列出客户端资源包必须覆盖的 materials、textures、models、tints 和 animations。联机客户端必须在读取 Chunk 前加载服务器目录，不自行复制隐含枚举或资源需求清单；本地 Worker 使用同一 `@openvoxel/blocks` 注册表。

响应包含以 `contentHash` 构造的强 ETag 和 `Cache-Control: public, max-age=0, must-revalidate`。客户端再次请求时可以发送 `If-None-Match`；目录未变化返回 304，服务端不会重新构造目录对象。

### `POST /api/worlds`

请求：

```json
{"id":"lesson-one","name":"Lesson One","seed":"openvoxel"}
```

返回 201 和完整世界清单。ID 已存在返回 409。

### `POST /api/worlds/find`

```json
{"worldId":"lesson-one"}
```

返回世界清单；不存在返回 404。

### `GET /api/worlds/:worldId/bootstrap`

在请求任何 Chunk 前读取一个世界的完整启动契约。响应包含世界清单、`clientContractVersion`、`protocolVersion`、client-contract/目录/实时端点、方块目录 schema/content hash、世界高度、海平面和最大 Chunk 批量数。客户端必须同时核对 `blockCatalogVersion`、`blockIdMapHash` 和本地已缓存目录；不一致时先刷新目录，仍不一致则不得解释 Chunk 中的数字 ID。

### `POST /api/chunks/query`

```json
{"worldId":"lesson-one","position":{"x":-1,"y":0,"z":2}}
```

服务根据世界清单确定性生成 Chunk，再叠加已保存的方块覆盖。生成结果本身不写入数据库。响应包含 `edge`、`revision` 和 4096 个最终方块 ID。

### `POST /api/chunks/batch`

```json
{"worldId":"lesson-one","positions":[{"x":0,"y":3,"z":0},{"x":0,"y":4,"z":0}]}
```

按请求顺序返回 1 到 64 个 Chunk。世界清单只读取一次，所请求 Chunk 的稀疏差异也由存储适配器一次性批量读取。

### `POST /api/generation/sample`

```json
{"worldId":"lesson-one","position":{"x":0,"z":0}}
```

返回该地形柱的精确表面高度、0–15 温湿度、海岸距离、山地因子、森林密度和生物群系。它用于教学、调试和未来的世界预览，不会创建 Chunk。

### `POST /api/blocks`

```json
{"worldId":"lesson-one","position":{"x":-1,"y":15,"z":32},"blockId":3}
```

响应包含旧方块、新方块、Chunk/局部坐标和新 revision；同时向所有 WebSocket 客户端广播变更事件。

## WebSocket

连接地址：`/api/events`。消息必须是 MessagePack 二进制数据，最大 64 KiB。

方块命令：

```json
{"operation":"set-block","worldId":"lesson-one","position":{"x":0,"y":30,"z":0},"blockId":3}
```

广播事件：

```json
{"event":"block.changed","worldId":"lesson-one","position":{"x":0,"y":30,"z":0},"previousBlockId":0,"blockId":3,"revision":1}
```

协议或应用错误也以 MessagePack 返回。HTTP、WebSocket 和 SQLite 恢复都使用同一“已注册且未退役 ID”校验，解析失败统一使用 `InvalidRequest`：

```json
{"event":"error","code":"InvalidRequest","message":"..."}
```

## 浏览器跨域

浏览器 origin 白名单由 `apps/server/application.yml` 的 `server.cors.allowedOrigins` 配置。预检允许 GET/POST、`content-type` 和 `if-none-match`；响应向浏览器暴露 `etag` 和 `x-openvoxel-protocol-version`。WebSocket upgrade 使用同一 origin 白名单，且两种传输都不使用跨域凭据。生产部署必须把开发 origin 换成实际站点的明确 origin。

第一阶段没有鉴权、玩家会话和冲突合并；revision 已预留给后续乐观并发控制。
