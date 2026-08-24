# 课程 03：显式原生后端模块

OpenVoxel 使用 VelarScript 原生 ServeApp，但世界生成代码仍然不知道 HTTP 或 WebSocket。这个约束比选用哪个服务宿主更重要。

阅读顺序：

1. `apps/server/src/modules/*.vel` 用 `server` 声明静态、受检查的业务路由。
2. `apps/server/src/server.vel` 只负责组合路由、中间件、生命周期和共享端口。
3. `apps/server/src/application.vel` 用普通工厂闭包组合 WorldRuntime、实时广播、部署限额和幂等关闭，并由一个 eager 应用级 Provider 负责释放。
4. `apps/server/src/error-handler.vel` 把领域错误归一为稳定公共信封，不泄露宿主内部错误名。
5. `apps/server/src/realtime-sessions.vel` 用 Vel 的结构化 `Task` 接纳和排空实时会话；`modules/realtime.vel` 只消费有界的拉取式 WebSocket 队列，并继续复用同一个世界运行时。

测试同样沿边界分层：多数 HTTP 行为通过 `velar/server-test` 的 Provider 覆盖验证真实 ServeApp 路由，不占端口或挂载进程状态；WebSocket 验收才启动真实共享端口。快速反馈与真实传输证据仍然是两层互补证明。
