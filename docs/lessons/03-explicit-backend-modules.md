# 第三课：框架应该停在边界

OpenVoxel 使用 Fastify，但世界生成代码从不导入 Fastify。这个约束比选用哪个框架更重要。

建议按以下顺序阅读：

1. `packages/npm/fastify/src/index.js` 只负责把成熟 npm 框架稳定成很窄的宿主接口。
2. `packages/backend/src/bridge.vel` 是唯一的 JavaScript 声明边界。
3. `packages/backend/src/index.vel` 把宿主接口转成类型化路由、统一异常和可测试生命周期。
4. `apps/server/src/server.vel` 是组合根，只创建依赖并注册模块。
5. `apps/server/src/modules` 中的控制器解析输入、调用用例，并用 `Response.ok` 等工厂构造输出。

这里没有 `@Controller`。每一条路由都由普通函数显式注册，每一个依赖都从构造参数进入。读者不需要知道反射容器如何扫描声明，也能从入口一路追到 Chunk 生成和 SQLite。

测试同样沿着边界分层：多数 HTTP 行为使用 Fastify 注入，不占端口；最终验收才启动真实 TCP 服务，并连接 MessagePack WebSocket。快速反馈与真实证据并不冲突。
