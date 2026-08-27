# OpenVoxel 当前协议

HTTP 与 WebSocket 语义由 `protocolVersion = 8` 标识，机器可读客户端清单由 `clientContractVersion = 8` 标识。世界持久化格式由清单中的 `formatVersion = 3` 独立标识。

## 传输分工

HTTP 提供可由世界种子、生成器目录和方块注册表重建的固定数据，适合缓存和并行批量读取。WebSocket 连接绑定一个世界，传输玩家形成的热增量并提交原子批量修改。客户端取得一个 Chunk 的当前状态时，先读取固定地形，再把实时同步得到的覆盖按 `revision` 应用到本地副本。

HTTP 成功响应直接返回资源数据。错误使用 `application/problem+json`，其中 `status` 是 HTTP 状态，`code` 是稳定机器身份，`title` 和可选 `detail` 用于显示和诊断。

```json
{
  "type": "about:blank",
  "title": "World not found",
  "status": 404,
  "code": "world.not_found",
  "detail": "World 'missing' was not found",
  "instance": "/api/worlds/missing"
}
```

所有 HTTP JSON 请求最大 64 KiB，MessagePack 实时消息最大 64 KiB。部署可以在 `apps/server/application.yml` 中收紧这些上限，`GET /api` 会发布当前实例采用的值。

## HTTP 资源

### `GET /api/health`

返回服务状态、服务名和当前协议版本。

### `GET /api`

返回编码、capability、公共错误码、MessagePack 命令与事件名、Chunk 编码、批量上限和部署传输限额。HTTP 路径以 `GET /api/openapi.json` 生成的 OpenAPI 3.1 文档为权威描述，客户端清单通过 `http.descriptionFormat = "openapi-3.1"` 指向它。

Chunk 编码固定为：

- `paletteEntries: "uint32-runtime-id"`：调色板项是该世界的 UInt32 方块状态运行时 ID。
- `localIndices: "uint16-list"`：4096 个局部索引指向调色板。
- `indexOrder: "x + edge * (z + edge * y)"`。

### `GET /api/openapi.json`

由实际路由注解生成 OpenAPI 3.1。参数位置、必选性、数据类型和错误响应都从同一份编译结果产生。`GET /api/docs` 提供使用这份文档的本地交互页面。

### `POST /api/worlds`

```json
{"id":"lesson-one","name":"Lesson One","seed":"openvoxel"}
```

创建世界并返回 201、完整 `WorldManifest` 和 `Location` 响应头。命令可提供 `generator` 与 `contentPacks`；省略时分别选择默认生成器和服务器配置的默认 Content Pack 集合。清单保存精确内容构建哈希、生成器哈希、出生点和该世界的方块运行时 ID 快照。

### `GET /api/worlds/{worldId}`

返回指定世界的完整清单。

### `GET /api/worlds/{worldId}/bootstrap`

返回建立客户端世界会话所需的事实：世界清单、协议版本、内容状态映射哈希、当前生成器高度范围、海平面和最大 Chunk 批量数。它不复制路由字符串；客户端从 OpenAPI 获得 HTTP 资源定义。

### `GET /api/worlds/{worldId}/content`

返回该世界实际锁定的 Content Pack 身份、方块 runtimeId 目录、去重后的 `componentProfiles`、渲染资源需求和生成器事实。响应 ETag 同时覆盖 `contentHash` 与 `stateMapHash`；客户端可通过 `If-None-Match` 获得 304。目录属于路径中的世界。

### `POST /api/worlds/{worldId}/terrain/chunks`

```json
{
  "positions": [
    {"x":0,"y":3,"z":0},
    {"x":0,"y":4,"z":0}
  ]
}
```

按请求顺序返回 1 到 64 个固定地形 Chunk。每项包含 `position`、`edge`、UInt32 `palette` 和 4096 个 UInt16 `indices`。这个资源不叠加玩家覆盖，也不携带热状态 revision；同一世界清单和同一生成器哈希下可长期复用。

### `GET /api/worlds/{worldId}/terrain/samples/{blockX}/{blockZ}`

返回最终地表高度、坡度、大陆度、侵蚀、山脊、河流强度、温湿度、森林密度、地形类型和群系，用于生成诊断和地图预览。

## 世界实时通道

连接地址为 `/api/worlds/{worldId}/realtime`。路径在握手时把连接绑定到一个世界，后续命令不再携带 `worldId`。服务端接受连接后首先发送：

```json
{"event":"world.ready","worldId":"lesson-one","protocolVersion":8,"sequence":0}
```

`sequence` 是订阅建立瞬间这个世界已经发布到的最后一个热事件序号。客户端把它
作为本次连接代际的起点，并对自己正在跟踪的全部 Chunk 执行 `chunks.sync`；随后
到达的 `blocks.changed` 必须连续递增，出现缺口时重新执行完整增量同步。

以下示例用 JSON 展示字段，线上编码均为 MessagePack 二进制。

### 同步 Chunk 增量

```json
{
  "operation":"chunks.sync",
  "requestId":"sync-1",
  "positions":[{"x":0,"y":1,"z":0}]
}
```

服务端只回复请求连接，并保持坐标顺序：

```json
{
  "event":"chunks.synced",
  "requestId":"sync-1",
  "worldId":"lesson-one",
  "chunks":[{
    "position":{"x":0,"y":1,"z":0},
    "revision":0,
    "overrides":[]
  }]
}
```

从未修改过的 Chunk 也会返回 `revision: 0` 和空覆盖列表，客户端无需把“未找到”解释成另一种状态。

### 原子批量修改方块

```json
{
  "operation":"blocks.apply",
  "requestId":"edit-1",
  "edits":[
    {"position":{"x":0,"y":30,"z":0},"blockStateRuntimeId":147},
    {"position":{"x":1,"y":30,"z":0},"blockStateRuntimeId":147}
  ]
}
```

批次包含 1 到 1024 项。同一坐标不能重复，全部坐标和状态会在写入前验证。活动世界按命令顺序计算完整 Chunk 变更，SQLite 在一个事务中按 expected revision 提交；同一 Chunk 内的真实变化只推进一次 revision。

请求方收到命令确认：

```json
{
  "event":"blocks.applied",
  "requestId":"edit-1",
  "worldId":"lesson-one",
  "sequence":1,
  "changes":[{
    "position":{"x":0,"y":30,"z":0},
    "chunk":{"x":0,"y":1,"z":0},
    "local":{"x":0,"y":14,"z":0},
    "previousBlockStateRuntimeId":1,
    "blockStateRuntimeId":147,
    "revision":1
  }]
}
```

同一世界的所有连接另收不携带玩家 `requestId` 的有序事实：

```json
{"event":"blocks.changed","worldId":"lesson-one","sequence":1,"changes":[{"revision":1}]}
```

完全幂等的批次只返回 `blocks.applied`，`sequence` 保持当前值且 `changes` 为空；它不会制造 `blocks.changed`。重新连接后客户端先采用新 `world.ready.sequence`，再用 `chunks.sync` 的持久化 revision 收敛。

### 实时错误

```json
{
  "event":"error",
  "requestId":"edit-1",
  "code":"block.unknown_state",
  "message":"..."
}
```

无法解析到 `requestId` 时该字段为 `null`。文本帧返回 `realtime.text_unsupported`，未知命令返回 `realtime.unsupported_operation`。

## 浏览器来源

浏览器来源白名单由 `apps/server/application.yml` 的 `server.cors.allowedOrigins` 配置。HTTP 预检和 WebSocket upgrade 使用同一份精确白名单，不启用跨域凭据。
