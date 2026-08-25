# ADR 0010：VelarScript 原生后端

状态：已接受

## 背景

旧实现通过仓库内的 Fastify JavaScript 适配器和 `@openvoxel/backend` Velar 门面提供动态路由、HTTP 注入与 WebSocket。VelarScript 0.12 当时缺少浏览器 Origin 的升级前拒绝，以及生产构建中的 HTTP/WebSocket 同端口启动契约，因此保留旧链路是必要的安全边界。

VelarScript 0.13 已提供声明式 `server` 路由、ServeApp 生命周期与中间件、测试客户端、WebSocket 精确 Origin 白名单，以及开发、serve 和生产构建一致的共享端口启动函数。旧适配层不再承担独有能力。

## 裁决

- `apps/server` 直接声明 system、world、chunk 和 block 路由，并在组合根统一挂载错误归一、CORS、请求 ID、安全响应头、并发限制和访问日志。
- HTTP 与 MessagePack WebSocket 通过 `velar/websocket.listen({http: app})` 共享一个端口；浏览器 Origin 在进入连接队列前按 YAML 白名单精确拒绝。
- SQLite 的当前表结构、世界注册表 JSON、世界操作、协议信封、世界运行时和实时广播归 OpenVoxel 所有；通用数据库操作层和 SQLite 连接资源来自 VelarScript Libraries，原生服务框架不获得数据库或游戏领域职责。
- 删除 `@openvoxel/backend` 与 `@openvoxel/fastify`，不保留双实现或隐藏回退路径。
- 领域值使用 `type`，行为使用普通函数；生成缓存、运行时和服务状态由工厂闭包拥有。只有错误类型和必须参与资源释放协议的外部连接句柄保留 class。应用不建立 Controller、Manager、Repository、Service 容器或其他 C# 风格层级。
- `provide` 只承载一个应用作用域的已组合服务能力，路由模块不各自复制 provider 或依赖容器。
- YAML 继续是部署配置权威；`velar.json` 只声明 Node 构建宿主要求的稳定启动形状和默认值。

VelarScript 0.13 按源码顺序求值。世界生成字段依次消耗种子随机流，固定种子的气候样本、特征覆盖坐标和 Chunk checksum 由当前实现的确定性 golden 锁定。

## 验证

多数 HTTP 行为使用 `velar/server-test` 的真实 ServeApp 路由器在进程内验证；WebSocket 使用真实本地共享端口验证 Origin 策略、MessagePack 错误、双订阅者广播和关闭生命周期。完整门禁继续由 `npm run validate` 执行。
