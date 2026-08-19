# OpenVoxel

OpenVoxel 是一个使用 VelarScript 从零构建体素世界的开源教学项目。它先完成没有前端也能独立验收的世界后端，再让浏览器单机模式和 Node 联机模式共享同一套领域核心。

当前完成的是后端世界生成纵向切片：创建世界后，`openvoxel:survival-v1` 会确定性生成气候、海岸、河流、丘陵、山地、洞穴、地下流体、七类矿物、地表和植被。生成的 16³ Chunk 随时可以由种子重建，不写入 SQLite；数据库只保存世界清单、被玩家改动的方块和对应 Chunk revision。联机服务使用 Fastify 5，HTTP 与 WebSocket 按业务模块进入同一个应用运行时；修改方块、重启恢复和广播继续走同一套用例。

## 开始使用

需要 Node.js 24 或更高版本。项目不使用 Bun。

```sh
npm install
npm run validate
npm start
```

服务默认监听 `http://127.0.0.1:3000`，SQLite 文件默认位于服务工作目录下的 `openvoxel.sqlite`。监听地址、协议限额和 SQLite 连接限额统一由 [`apps/server/config/server.yml`](apps/server/config/server.yml) 管理；可以用 `OPENVOXEL_CONFIG` 选择另一份配置，并用 `OPENVOXEL_HOST`、`OPENVOXEL_PORT`、`OPENVOXEL_LOGGER`、`OPENVOXEL_DB` 覆盖部署相关值。

```sh
curl http://127.0.0.1:3000/api/health

curl -X POST http://127.0.0.1:3000/api/worlds \
  -H 'content-type: application/json' \
  -d '{"id":"lesson-one","name":"Lesson One","seed":"openvoxel"}'

curl -X POST http://127.0.0.1:3000/api/chunks/query \
  -H 'content-type: application/json' \
  -d '{"worldId":"lesson-one","position":{"x":0,"y":0,"z":0}}'

curl -X POST http://127.0.0.1:3000/api/generation/sample \
  -H 'content-type: application/json' \
  -d '{"worldId":"lesson-one","position":{"x":0,"z":0}}'
```

WebSocket 地址是 `ws://127.0.0.1:3000/api/events`，命令和事件都使用 MessagePack。完整契约见 [协议 v1](docs/protocol-v1.md)。

## 架构

```mermaid
flowchart LR
    C["未来客户端统一接口"] --> L["LocalBackend / Browser Worker"]
    C --> O["OnlineBackend / HTTP + WebSocket"]
    L --> R["@openvoxel/world-runtime"]
    O --> F["Fastify adapter"]
    F --> B["@openvoxel/backend"]
    B --> M["Server modules"]
    M --> R
    R --> D["@openvoxel/domain"]
    R --> P["WorldManifestStore + WorldDeltaStore"]
    P --> I["Memory / IndexedDB adapter"]
    P --> Q["SQLite sparse-delta adapter"]
```

仓库分层：

- `packages/domain`：坐标、Chunk、世界清单和确定性生成；不导入 Node 能力。
- `packages/blocks`：由 `data/blocks.yml` 生成的跨 Node/浏览器方块注册表；拥有稳定 ID、模拟属性和声明式渲染描述。
- `packages/config`：基于成熟 `yaml` npm 包的受检查 YAML 解析边界。
- `packages/backend`：显式路由、统一错误处理、生命周期、日志和 WebSocket 会话的 Velar 门面。
- `packages/protocol`：HTTP 和 MessagePack WebSocket 的应用协议。
- `packages/world-runtime`：创建世界、查询 Chunk、修改方块等用例和存储端口。
- `apps/server`：system、world、chunk、block、realtime 模块，以及 SQLite 适配器和组合根。
- `packages/npm`：成熟 npm 包的窄桥接面，目前包含 Fastify、`@fastify/websocket`、`async-mutex` 和 fast-check。
- VelarScript 工具链由 npm 和 `package-lock.json` 统一解析与锁定。

应用边界和标准库晋升规则见 [ADR 0001](docs/architecture/0001-application-boundary.md)，Chunk 格式见 [ADR 0002](docs/architecture/0002-world-format-v1.md)，世界生成裁决见 [ADR 0004](docs/architecture/0004-survival-world-generation.md)，服务框架裁决见 [ADR 0005](docs/architecture/0005-fastify-backend.md)，稀疏世界存储见 [ADR 0006](docs/architecture/0006-sparse-world-deltas.md)，YAML 配置与方块目录裁决见 [ADR 0007](docs/architecture/0007-yaml-configuration-and-block-catalog.md)。

生成性能基线可以独立运行：

```sh
npm run benchmark:worldgen
npm run benchmark:columns
npm run benchmark:caves
```

世界生成基线会生成固定的 192 个 Chunk，报告总耗时、平均耗时和聚合校验和；地形柱基线比较垂直层重复计算与 64 项水平 LRU 缓存；洞穴基线比较逐 Chunk 重放与有界计划缓存。两个专项基准都要求两条路径的聚合校验和相同，让性能变化与语义变化不会混在一起。

## 当前边界

当前阶段不包含渲染、玩家、登录、移动、物品、合成和进程内 Chunk 缓存。后端已经提供单 Chunk、最多 64 个 Chunk 的批量读取、方块目录和地形诊断接口；浏览器 Worker 适配器仍留到下一阶段。Chunk 缓存会在客户端访问模式有真实性能数据后再决定是否引入 `lru-cache`。

OpenVoxel 的代码不会写入 VelarScript 仓库。只有一项能力在多个独立应用和运行目标中反复出现、具备领域无关的稳定语义，并且应用包已无法合理承载时，才会单独评估是否晋升为标准库。
