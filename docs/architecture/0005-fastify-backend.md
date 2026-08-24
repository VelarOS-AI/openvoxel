# ADR 0005：Fastify 后端与显式模块

状态：已被 [ADR 0010](0010-native-velarscript-backend.md) 取代

## 背景

第一条纵向切片曾直接用 `velar/serve` 判断请求方法和路径。它能证明网络到世界运行时的链路，却把路由、解析、错误映射和响应拼装集中在一个函数中；继续增加接口会让传输层变成不可维护的条件分支。

## 裁决

联机服务采用 Fastify 5 和 `@fastify/websocket`。第三方对象只存在于 `packages/npm/fastify`，`packages/backend` 在其上提供受检查的 Velar 门面：

- 显式注册 GET、POST 和 WebSocket 路由。
- 控制器统一返回 `Response`，通过 `ok`、`created`、`of` 和 `failure` 构造响应，不拼装传输层记录；线上 JSON 固定为 `{code, data, message}`。
- 集中处理应用异常、框架异常、404 和请求体限额。
- 统一拥有启动、关闭、日志和连接资源。
- 使用 Fastify 注入完成多数 HTTP 测试，只为真实 TCP 和 WebSocket 保留端到端验收。

`apps/server` 按 system、world、chunk、block 和 realtime 模块组合控制器。控制器解析协议输入并调用 `@openvoxel/world-runtime`，领域层不知道 Fastify、HTTP 或 WebSocket 的存在。

## 为什么没有装饰器

VelarScript 不提供用户定义装饰器，OpenVoxel 也不会为模仿 Nest 的表面语法扩张语言。路由注册保持显式，模块依赖通过构造参数组合。这样既避免反射元数据和隐式容器，也让教学读者能沿普通函数调用追踪完整执行路径。

Fastify 的运行时 `decorate()` 属于其插件机制，不等于源码中的 `@Controller` 或 `@Get`，不会暴露到 OpenVoxel 的 Velar API。

## 边界

- 浏览器单机模式不携带 Fastify；它会在 Worker 中直接适配同一个世界运行时。
- Fastify 负责网络协议、路由生命周期和日志，不拥有世界规则。
- WebSocket 桥只补充有界拉取队列和发送背压，消息语义仍由 `packages/protocol` 定义。
- 如果未来更换网络框架，只替换 npm 桥和 `packages/backend` 实现，不改领域和用例包。
