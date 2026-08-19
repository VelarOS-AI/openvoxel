# OpenVoxel 协议 v1

所有 HTTP JSON 请求最大 64 KiB。世界与 Chunk 的领域格式版本由世界清单中的 `formatVersion` 表示；传输协议版本由健康检查中的 `protocolVersion` 表示。

## HTTP

所有 HTTP 响应使用同一个信封：

```json
{"code":"OK","data":{},"message":"success"}
```

- `code` 是稳定的字符串业务码；成功通常为 `OK`，创建成功为 `CREATED`，失败使用具体错误类或框架错误码。
- `data` 保存业务数据；没有错误详情时为 `null`。
- `message` 是供人阅读的说明，客户端分支必须读取 `code`，不能匹配文案。
- HTTP status 仍表达传输结果，不重复塞进 JSON 字段。

### `GET /api/health`

```json
{"code":"OK","data":{"status":"ready","service":"openvoxel","protocolVersion":1},"message":"success"}
```

### `GET /api/blocks`

返回 `openvoxel:survival-v1` 的世界高度、海平面和完整方块目录。目录携带 `schemaVersion`、`catalogVersion` 与 YAML 权威源的 `contentHash`，每个方块同时包含稳定 ID、key、标签、模拟属性和声明式渲染描述。联机客户端必须在读取 Chunk 前加载服务器目录，不自行复制隐含枚举；本地 Worker 使用同一 `@openvoxel/blocks` 注册表。

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

协议或应用错误也以 MessagePack 返回：

```json
{"event":"error","code":"AssertionError","message":"..."}
```

第一阶段没有鉴权、玩家会话和冲突合并；revision 已预留给后续乐观并发控制。
