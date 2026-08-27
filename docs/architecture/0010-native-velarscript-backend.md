# ADR 0010：VelarScript 原生后端

状态：已接受

## 裁决

- `apps/server` 使用 VelarScript 0.19 的声明式 `server` 路由、`p"..."` RoutePattern、依赖输入和应用生命周期。
- HTTP 与声明式 `@websocket` 路由由同一监听器托管。浏览器 Origin 在升级前按 YAML 白名单精确验证。
- system、world、terrain、block catalog 和 realtime 各自拥有窄路由模块，组合根只负责文档、中间件、生命周期与监听参数。
- 路由路径直接写在注解上。内联 RoutePattern 把路径变量投影成处理函数的只读输入，框架从同一编译结果生成 OpenAPI。
- 成功值直接进入框架内容协商；创建资源使用 `created`，带 ETag 的目录使用 `respond`，错误使用 `HttpProblem` 和 `application/problem+json`。
- 每个实时连接由 URL 绑定一个世界。`velar/realtime` 为连接提供一条有界发送队列、唯一 writer、串行命令读取和确定性 cleanup；世界热状态直接保存 `RealtimePeer<Bytes>` 并按世界非阻塞广播，不再叠加 Channel 和转发任务。慢订阅者队列满时只关闭该连接，不能阻塞其他玩家。
- 世界写入只通过 MessagePack `blocks.apply` 进入运行时原子批量用例。HTTP terrain 资源只返回可重建固定数据。
- SQLite 当前表结构、世界注册表 JSON、稀疏增量和实时消息归 OpenVoxel 所有；通用数据库操作与 SQLite 连接来自 VelarScript Libraries。
- 领域值使用 `type`，行为使用普通函数和闭包状态。应用作用域只提供一份已经组合完成的 `OpenVoxelApplication`。
- `apps/server/application.yml` 是部署配置权威；`velar.json` 同时声明构建入口、输出目录、服务端扩展及 `server.configuration` 路径，因此配置位置可见且可修改。

## 生命周期

启动阶段挂载唯一应用实例，框架按请求和连接解析同一 provider。每条实时会话在 `opened` 中验证世界并注册订阅，框架保证返回的 cleanup 恰好执行一次。关闭时先请求所有 RealtimePeer 以 1001 排空并关闭，再等待世界运行时和数据库资源释放；声明式 WebSocket 会话加入监听器生命周期，服务器停止会等待这些处理任务结束。

## 验证

HTTP 验收通过 `velar/server-test` 的真实 ServeApp 路由器检查原生数据响应、Problem Details、OpenAPI、ETag 和 CORS。WebSocket 验收通过真实共享端口检查 Origin、世界绑定、MessagePack 错误、Chunk 增量同步、原子批量广播、世界隔离和关闭生命周期。生产构建还要检查生成 JavaScript 中的路由参数、WebSocket 元数据和输出模式。
