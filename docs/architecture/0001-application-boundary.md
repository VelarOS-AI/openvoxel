# ADR 0001：应用边界与标准库晋升

状态：已接受

## 裁决

OpenVoxel 的世界模型、网络协议、存储结构、生成算法和 npm 适配器全部由 OpenVoxel 仓库拥有。VelarScript 仓库只拥有语言、编译器和跨领域运行时能力。

缺少能力时按以下顺序处理：

1. 先在 OpenVoxel 内实现。
2. 如果已有成熟 npm 实现，通过受检查的 `extern module` 和窄 Velar 门面适配。
3. 当能力被多个 OpenVoxel 模块复用时，提炼为独立的 `@openvoxel/*` 包。
4. 只有在多个独立应用和 Node/Web 等不同目标中反复出现后，才启动标准库资格评估。

## 标准库资格

反复出现只是开始评估的信号，不是自动晋升。候选能力还必须同时满足：

- 语义与体素、游戏和 OpenVoxel 领域无关。
- 应用包无法合理提供所需的安全、性能或跨目标一致性。
- API 已在真实使用中稳定，而不是为预想场景设计。
- 能承担长期兼容、文档和全目标验证成本。
- 通过独立的 VelarScript 架构裁决，不在 OpenVoxel 开发中顺手内置。

因此 OpenVoxel 是 VelarScript 的教学项目和证据来源，但不是扩张标准库的后门。

当前实例是 `@openvoxel/backend`：它在应用仓库内把 Fastify 适配成 VelarScript 可使用的显式后端接口，没有把路由、装饰器、依赖注入或 WebSocket 框架写入 VelarScript 标准库。
