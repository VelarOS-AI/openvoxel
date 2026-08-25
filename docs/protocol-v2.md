# OpenVoxel 协议 v2

所有 HTTP JSON 请求最大 64 KiB。世界和 Chunk 的领域格式由世界清单中的 `formatVersion` 表示；HTTP 与 WebSocket 语义由 `protocolVersion` 表示；机器可读客户端清单当前为 `clientContractVersion = 3`。

## HTTP 信封

所有 HTTP JSON 响应使用统一信封：

```json
{"code":"OK","data":{},"message":"success"}
```

- `code` 是客户端分支使用的稳定业务码。
- `data` 保存业务数据，错误没有详情时为 `null`。
- `message` 只供人阅读。
- HTTP status 表达传输结果。

### `GET /api/health`

```json
{"code":"OK","data":{"status":"ready","service":"openvoxel","protocolVersion":2},"message":"success"}
```

### `GET /api/client-contract`

这是客户端接入的机器可读入口。它发布全部 HTTP method/path、MessagePack 实时消息名、Chunk 调色板编码、索引顺序、传输限额、capability、公共错误码和当前基础方块目录身份。

Chunk 契约固定为：

- `paletteEntries: "uint32-runtime-id"`：调色板项是每世界 UInt32 方块状态运行时 ID。
- `localIndices: "uint16-list"`：每个体素保存指向调色板的 UInt16 局部索引。
- `indexOrder: "x + edge * (z + edge * y)"`。

响应使用 `Cache-Control: no-store`。VelarScript 客户端直接依赖 `@openvoxel/protocol` 获得精确类型；其他语言以该响应和本文档为准。

### `GET /api/blocks`

返回基础方块目录、世界高度和渲染资源需求。目录包含 `schemaVersion`、`catalogVersion`、覆盖规范状态键与基础运行时 ID 的 `stateMapHash`，以及覆盖完整组件内容的 `contentHash`。`blocks` 给出方块类型，`states` 给出每个有限状态的 UInt32 `runtimeId`、完整属性、物理、光照、交互、行为和渲染描述。

响应使用由 `contentHash` 构造的强 ETag 和 `Cache-Control: public, max-age=0, must-revalidate`。客户端可发送 `If-None-Match`，内容未变化时返回 304。

### `POST /api/worlds`

```json
{"id":"lesson-one","name":"Lesson One","seed":"openvoxel"}
```

返回 201 和完整世界清单。世界清单持有该世界的 `blockRegistry` 快照，其中记录 `formatVersion`、下一个 Mod 运行时 ID，以及全部 `runtimeId`/`stateKey` 映射。

### `POST /api/worlds/find`

```json
{"worldId":"lesson-one"}
```

返回完整世界清单；不存在返回 404。

### `GET /api/worlds/:worldId/bootstrap`

在请求 Chunk 前读取世界启动契约。响应包含完整世界清单和 `blockRegistry`、协议与客户端契约版本、相关端点、基础目录哈希、世界高度、海平面和最大 Chunk 批量数。客户端用世界注册表解释 Chunk 调色板中的运行时 ID，并从当前目录和已启用 Mod 目录取得对应状态内容。

### `POST /api/chunks/query`

```json
{"worldId":"lesson-one","position":{"x":-1,"y":0,"z":2}}
```

服务确定性生成基础 Chunk，再叠加已保存的方块覆盖。响应包含 `edge`、`revision`、UInt32 `palette` 和 4096 个 UInt16 `indices`。体素的方块状态为 `palette[indices[index]]`。

### `POST /api/chunks/batch`

```json
{"worldId":"lesson-one","positions":[{"x":0,"y":3,"z":0},{"x":0,"y":4,"z":0}]}
```

按请求顺序返回 1 到 64 个 Chunk。世界清单只读取一次，所请求 Chunk 的稀疏差异由存储适配器批量读取。

### `POST /api/generation/sample`

```json
{"worldId":"lesson-one","position":{"x":0,"z":0}}
```

返回地形柱的表面高度、温湿度、海岸距离、山地因子、森林密度和生物群系，不创建 Chunk。

### `POST /api/blocks`

```json
{"worldId":"lesson-one","position":{"x":-1,"y":15,"z":32},"blockStateRuntimeId":147}
```

运行时先确认该 ID 存在于目标世界的 `blockRegistry`，再写入稀疏覆盖。响应包含旧状态、新状态、Chunk/局部坐标和新 revision，并广播变更事件。

## WebSocket

连接地址为 `/api/events`。消息必须是 MessagePack 二进制数据，最大 64 KiB。

方块命令：

```json
{"operation":"set-block","worldId":"lesson-one","position":{"x":0,"y":30,"z":0},"blockStateRuntimeId":147}
```

广播事件：

```json
{"event":"block.changed","worldId":"lesson-one","position":{"x":0,"y":30,"z":0},"previousBlockStateRuntimeId":0,"blockStateRuntimeId":147,"revision":1}
```

协议和应用错误也以 MessagePack 返回：

```json
{"event":"error","code":"InvalidRequest","message":"..."}
```

## 浏览器跨域

浏览器 origin 白名单由 `apps/server/application.yml` 的 `server.cors.allowedOrigins` 配置。预检允许 GET/POST、`content-type` 和 `if-none-match`；响应向浏览器暴露 `etag` 和 `x-openvoxel-protocol-version`。WebSocket upgrade 使用同一白名单，两种传输都不使用跨域凭据。
