# ADR 0014：职责模块与异步所有权

状态：已接受

## 包与模块

包按职责族群组织：`content`、`world`、`client` 下的叶目录分别发布自己的契约；`protocol` 拥有线上形状。运行环境单独写入包清单。包内按变化原因拆模块，组合根连接端口，状态与资源由实际执行该职责的模块拥有。

| 位置 | 所有者 | 扩展点 |
| --- | --- | --- |
| `packages/world/runtime/src/world-context.vel` | 精确内容、注册表、生成器与生态的世界上下文装配 | 新的世界级模拟上下文 |
| `packages/world/runtime/src/world-sessions.vel` | single-flight、引用计数、租约、LRU 和关闭 | 世界驻留策略 |
| `packages/world/runtime/src/contracts.vel` | 持久化端口与玩家覆盖 | 存储适配器 |
| `packages/world/runtime/src/world-chunk-snapshot.vel` | 查询得到的可见世界快照 | 运行时自然覆盖层 |
| `apps/server/src/adapters/sqlite-world-store/` | 连接选项、schema、清单映射、增量事务 | SQLite 编码与查询策略 |
| `packages/client/access/src/session.vel` | 接入事实校验、请求关联、同代际同步与广播重放 | 会话用例 |
| `packages/client/access/src/session-connection.vel` | 活跃连接、连接代际、迟到连接释放 | 后端连接实现 |
| `packages/client/access/src/session-environment.vel` | 权威环境锚点、生态时间槽与公平刷新队列 | 环境刷新策略 |
| `packages/client/access/src/chunk-load-ownership.vel` | 重叠冷加载的成功/失败所有权 | 加载取消与回滚 |
| `apps/web/src/worlds/world-experience.vel` | 会话、首屏数据、渲染器的阶段获取与回收 | 世界进入流程 |
| `apps/web/src/worlds/world-entry.vel` | 浏览器本地后端和 Canvas 的具体组装 | 宿主入口 |
| `apps/web/src/rendering/world-renderer.vel` | 会话、流送、构网、环境、碰撞 readiness 与 Surface 组合 | 客户端世界体验 |
| `apps/web/src/rendering/chunk-streamer.vel` | 唯一流送任务、最新完整视窗与分批提交 | 视区与驻留策略 |
| `apps/web/src/rendering/chunk-meshing.vel` | 构网优先级、票据、失效、Portal 和提交 | 网格调度策略 |
| `apps/web/src/rendering/chunk-mesh-worker.vel` | Worker 获取、初始化及消息适配 | 构网执行宿主 |
| `apps/web/src/rendering/environment-sync.vel` | 天气和生态的独立调度任务 | 宿主刷新节拍 |
| `packages/client/rendering/src/meshing/` | 状态读取、Portal 洪泛、面策略、模型与 buffer 输出 | 模型和面优化 |
| `packages/client/rendering/src/native/babylon/` | 相机、材质、天空、环境贴图与 GPU 生命周期 | 原生呈现能力 |

## 世界事实与持久化

`StoredChunkDelta` 只包含玩家稀疏覆盖与 revision，由存储端口和热缓存消费。
`WorldChunkSnapshot` 是运行时查询结果，明确包含 `ecologyEpoch`；自然冰雪先作用于固定地形，再叠加玩家覆盖。没有自然候选项的 Chunk 同样具有查询时间槽。

快照包装的对象身份与缓存命中无关；缓存拥有的只读覆盖列表可以共享。存储适配器只接收存储契约，协议形状由 Server presentation 或 Local Worker 投影。运行时公开门面提供用例、输入输出、存储端口和错误；内容、世界模型及包内缓存构造器各由自己的模块拥有。

## 异步所有权

1. 每次连接安装新建同步状态。旧请求的完成、错误或 `finally` 只收敛旧代际；新连接的广播与生态调度独立前进。请求响应先确认仍属于当前连接，再进行请求关联和状态写入。
2. 关闭先同步封住入口与回调，再等待已拥有的任务回收。挂起获取的连接和渲染器在迟到返回时由发起者释放；重复关闭共享同一次完成。
3. 世界进入分为会话、首屏准备、渲染器三个阶段。页面拥有一个体验实例和一份统计事实；页面退出不会继续推进下一阶段。
4. 流送只保留最新的完整视窗与版本。每批四个 Chunk 先加载再配对卸载；切换目标发生在成对提交之后，确保驻留有界与当前视区连续。
5. 构网使用单调票据验证 Worker 返回和 GPU 提交。物理已安装网格与当前内容是否有效是两个事实；任务取消不能把旧网格误认为已从 GPU 移除。
6. 碰撞 readiness 由已完成冷热同步的 Chunk 决定。未知区域保守阻挡，首屏安全条件不会由任务队列计数替代。
7. 生态刷新一次最多四个 Chunk，单在途；队尾跨时间槽保持公平。天气采样与生态请求分别调度，重连等待期间生态刷新保持空闲。取消令牌贯穿调度、会话与传输请求，关闭等待实际请求收敛。

## 原生渲染边界

Velar 模块提供受检端口，原生实现集中在 `.mjs` 中。`surface-contract` 在创建 Engine 前检查相机、世界界限、移动模式和 TypedArray 上传约束；`material-library` 统一解析材质、纹理 bank、动画及 PBR；`surface-lifetime` 负责逆序释放，并保证一项清理失败仍会继续回收其它资源。

`environment-contract` 拥有资源/frame 校验，`environment-textures` 拥有异步贴图批次。批次失败会回收已完成及随后完成的贴图；天空层拥有自己的 shader 与 mesh。环境组合器连接灯光、阴影、天空和天气，各贴图的采样、混合方式由相应呈现职责维护。

构网代码保持纯数据闭包，经精确 `@openvoxel/renderer/meshing-worker` 入口进入 Worker。方块运行时 ID 用于世界状态索引，texture/material/model/tint 的逻辑身份用于资源解析。

## 自动门禁

`tools/architecture/policy.mjs` 声明包职责、执行环境与工具链版本规则。
`module-boundaries.mjs` 使用安装版本编译器公开的模块检查 API 读取真实 import、re-export、动态导入和资源依赖；语法与解析语义由编译器拥有。

`npm run structure:check` 验证源码与清单的依赖一致性、公开入口、私有 aliases、生产/开发边界、职责包路径、文档路径和全部工具链精确版本。生成数据通过公开资源入口消费；生成代码和测试辅助件各留在自己的边界。`npm run test:structure` 用独立夹具证明违规路径确实会被拒绝，两者都属于 `validate:static`。

修改模块时先用 `velar graph --focus` 确认调用和状态关系；按所有者运行聚焦测试。涉及公开契约、多个包或原生呈现时，完整 `npm run validate` 继续覆盖生成一致性、类型、格式、单元测试、构建、GPU 和浏览器流程。
