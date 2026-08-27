# OpenVoxel

OpenVoxel 是一个使用 VelarScript 从零构建体素世界的开源教学项目。它先完成没有前端也能独立验收的世界后端，再让浏览器单机模式和 Node 联机模式共享同一套世界模型、生成器和应用运行时。

当前完成的是后端世界生成纵向切片：创建世界后，`openvoxel:survival-v2` 会确定性生成气候、海岸、河流、丘陵、山地、洞穴、地下流体、七类矿物、地表和植被。生成的 16³ Chunk 随时可以由种子重建，不写入 SQLite；数据库只保存世界清单、玩家形成的稀疏覆盖和对应 Chunk revision。联机服务使用 VelarScript 0.19 的声明式 ServeApp、WebSocket 路由和类型化实时会话：HTTP 批量读取固定地形，世界绑定的实时通道同步热增量并原子提交批量方块修改。

## 开始使用

需要 Node.js 24 或更高版本。项目不使用 Bun。

```sh
npm install
npm run validate
npm start
```

服务默认监听 `http://127.0.0.1:3000`，SQLite 文件默认位于服务应用目录下的 `apps/server/openvoxel.sqlite`。项目显式激活 `@velarscript/server`，监听地址、浏览器允许来源、协议限额和 SQLite 连接限额统一由根配置 [`apps/server/application.yml`](apps/server/application.yml) 管理；这是框架唯一按约定发现的应用配置文件名。相对配置路径和数据库路径都以服务应用目录解析。VelarScript 启动器与 npm workspace 脚本会把该目录设为工作目录；从其他目录直接运行构建物时，用绝对的 `OPENVOXEL_ROOT` 明确指定它。可以用 `OPENVOXEL_CONFIG` 选择另一份显式 YAML/JSON 配置，并用 `OPENVOXEL_HOST`、`OPENVOXEL_PORT`、`OPENVOXEL_LOGGER`、`OPENVOXEL_DB` 覆盖部署相关值；密码、令牌等机密只能从部署环境注入，不进入应用配置。

```sh
curl http://127.0.0.1:3000/api/health

curl http://127.0.0.1:3000/api

curl -X POST http://127.0.0.1:3000/api/worlds \
  -H 'content-type: application/json' \
  -d '{"id":"lesson-one","name":"Lesson One","seed":"openvoxel"}'

curl http://127.0.0.1:3000/api/worlds/lesson-one/bootstrap

curl http://127.0.0.1:3000/api/worlds/lesson-one/content

curl -X POST http://127.0.0.1:3000/api/worlds/lesson-one/terrain/chunks \
  -H 'content-type: application/json' \
  -d '{"positions":[{"x":0,"y":0,"z":0},{"x":0,"y":1,"z":0}]}'

curl http://127.0.0.1:3000/api/worlds/lesson-one/terrain/samples/0/0

curl http://127.0.0.1:3000/api/openapi.json
```

每个连接通过 `ws://127.0.0.1:3000/api/worlds/{worldId}/realtime` 进入一个共享世界，命令和事件使用 MessagePack。完整契约见 [当前协议](docs/protocol.md)，可交互文档位于 `/api/docs`。

Mod 人工源与运行时产物分开构建：源目录包含 `content.yml`、`identities.yml` 以及可选的 `blocks/`、`world-generation/`，构建目录只接收 `content-pack.json`。服务器在 `application.yml` 的 `content.packArtifacts` 中安装产物，并用 `defaultPacks` 选择新世界默认内容。

```sh
OPENVOXEL_CONTENT_SOURCE=/absolute/mod-source \
OPENVOXEL_CONTENT_BUILD=/absolute/mod-build \
npm run compile:mod --workspace @openvoxel/content
```

## 架构

```mermaid
flowchart LR
    C["@openvoxel/client 世界会话"] --> L["LocalBackend / Browser Worker"]
    C --> O["OnlineBackend / HTTP + WebSocket"]
    L --> R["@openvoxel/world-runtime"]
    O --> N["VelarScript native HTTP + WebSocket"]
    N --> M["Server modules"]
    M --> R
    R --> W["@openvoxel/world"]
    R --> K["@openvoxel/content"]
    K --> B
    K --> G
    R --> G["@openvoxel/world-generation"]
    G --> W
    W --> B["@openvoxel/blocks"]
    G --> B
    R --> P["WorldManifestStore + WorldDeltaStore"]
    P --> I["Memory / IndexedDB adapter"]
    P --> Q["OpenVoxel SQLite sparse-delta adapter"]
    Q --> A["@velarscript-labs/database operations"]
    A --> S["@velarscript-labs/sqlite"]
```

仓库分层：

- `packages/blocks`：由 `identities.yml` 集中定义内建身份，分组方块 YAML 直接使用同层级打点路径，并用唯一 JSON 产物发布编译目录；源码按 `definition`、`compiler`、`runtime` 分层，拥有规范状态键、UInt32 运行时 ID、每世界 Mod 注册表、有限状态和声明式组件契约。
- `packages/world`：坐标、Chunk 调色板和世界清单等稳定世界模型；只维护数据结构与不变量，不选择生成算法或编排存储。
- `packages/world-generation`：生成器注册入口与确定性生存生成算法；地形、洞穴、地下流体、矿物和植被按阶段分离，不负责后续 Tick 模拟。
- `packages/content`：把一个 Mod 的共享身份、方块贡献和生成器贡献编译成独立 `content-pack.json`，并按精确哈希组合每世界内容集合。
- `packages/client`：传输无关的客户端世界会话；验证服务与世界身份，以紧凑冷数据和稀疏热覆盖组合 Chunk，并统一处理 requestId、sequence、revision、多批次同步与重连竞争。
- `packages/client-web`：浏览器在线适配器；只接收 OpenAPI 地址，按稳定 operationId 发现 HTTP 与 WebSocket 路由，并用 JSON、MessagePack 和框架实时客户端实现 `WorldBackend`。
- `packages/protocol`：只拥有 HTTP 和 MessagePack WebSocket 的线上数据类型、协议版本与客户端接入事实；实际 HTTP 路由由服务端注解和 OpenAPI 共同描述。
- `packages/world-runtime`：创建世界、解析精确内容、读取固定地形、缓存活动世界增量、顺序提交原子批次和发布有序世界事件等用例与存储端口。
- `apps/server`：system、world、chunk、block、realtime 模块，负责把领域值投影成协议响应；同时拥有当前表结构、世界注册表 JSON、稀疏世界规则的 SQLite 适配器与组合根。
- `@velarscript/server` 是显式激活的官方服务端应用扩展，负责应用配置、启动约定，以及类型化实时会话的一条有界发送队列、唯一 writer 和确定性清理；世界身份、MessagePack 命令、广播范围与错误码仍归 OpenVoxel。`@velarscript-labs/yaml` 仅用于方块目录生成，`@velarscript-labs/database` 与 `@velarscript-labs/sqlite` 仍是非标准的 VelarScript Libraries。
- VelarScript 官方工具链继续使用 `@velarscript/*`；Libraries 非标准包统一从公开 npm scope `@velarscript-labs/*` 安装。两个命名空间的所有权在依赖名上直接可见，并由 lockfile 固定版本与完整性。

目录按职责固定：手写运行时代码进入 `src/`，测试进入 `tests/`，测试辅助件进入 `tests/support/`，性能基准进入 `benchmarks/`，人工数据进入 `data/`，生成物进入 `generated/`，生成与检查脚本进入 `tools/`。`src/` 不放测试和生成物，`generated/` 禁止生成 `.vel`；`npm run structure:check` 和完整门禁会持续检查这两条规则。

应用边界和标准库晋升规则见 [ADR 0001](docs/architecture/0001-application-boundary.md)，Chunk 格式见 [ADR 0002](docs/architecture/0002-world-format-v1.md)，世界生成裁决见 [ADR 0004](docs/architecture/0004-survival-world-generation.md)，原生服务框架裁决见 [ADR 0010](docs/architecture/0010-native-velarscript-backend.md)，稀疏世界存储见 [ADR 0006](docs/architecture/0006-sparse-world-deltas.md)，YAML 定义与 JSON 方块产物见 [ADR 0007](docs/architecture/0007-yaml-configuration-and-block-catalog.md)，每世界方块注册表见 [ADR 0008](docs/architecture/0008-world-block-registry.md)，客户端接入契约见 [ADR 0009](docs/architecture/0009-client-contract-boundary.md)，方块类型与有限状态地基见 [ADR 0011](docs/architecture/0011-block-type-and-state-foundation.md)，世界模型与生成边界见 [ADR 0012](docs/architecture/0012-world-model-and-generation-boundary.md)。

生成性能基线可以独立运行：

```sh
npm run benchmark:worldgen
npm run benchmark:columns
npm run benchmark:caves
```

世界生成基线会生成固定的 192 个 Chunk，报告总耗时、平均耗时和聚合校验和；地形柱基线比较垂直层重复计算与 64 项水平 LRU 缓存；洞穴基线比较逐 Chunk 重放与有界计划缓存。两个专项基准都要求两条路径的聚合校验和相同，让性能变化与语义变化不会混在一起。

## 当前边界

当前阶段不包含渲染、玩家身份、登录、移动、物品和合成。后端已经提供最多 64 个固定地形 Chunk 的批量读取、每世界内容目录、地形诊断、按世界隔离的热增量同步与最多 1024 项的原子方块编辑；客户端应用层已经能够组合冷热 Chunk 和恢复重连状态。下一层是由框架生成的稳定路由操作身份与浏览器在线适配器，随后接浏览器 Worker 本地适配器。

OpenVoxel 的业务代码不会写入 VelarScript 主仓库或 VelarScript Libraries。只有能力具备领域无关的稳定语义、已有真实复用证据，并能独立承担兼容与验证成本时，才会进入 Libraries；进入 Libraries 也不等于晋升为 `velar/*` 标准库。
