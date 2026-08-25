# ADR 0001：应用边界与标准库晋升

状态：已接受

## 裁决

OpenVoxel 的世界模型、网络协议、存储结构、生成算法、当前表结构和部署配置全部由 OpenVoxel 仓库拥有。VelarScript 主仓库只拥有语言、编译器和 `velar/*` 标准能力；独立的 VelarScript Libraries 仓库维护官方但非标准的通用可复用包，类似 VelarScript 自己的 npm 包生态。主仓库不能反向依赖 Libraries。

缺少能力时按以下顺序处理：

1. 先检查 VelarScript 标准库和 VelarScript Libraries 是否已经提供通用能力。
2. OpenVoxel 从公开 npm scope `@velarscript-labs/*` 直接安装符合边界的 Libraries 包，不再复制一层同义 `@openvoxel/*` 门面；`@velarscript/*` 保留给标准能力和官方工具链。
3. OpenVoxel 特有逻辑留在所属领域、用例或应用适配器中；同一项目内复用不是搬入 Libraries 的理由。
4. 缺少通用外部桥时，先用受检查的 `extern module` 在实际使用边界验证语义；只有出现跨应用复用证据，才单独评估进入 Libraries。
5. 晋升为 `velar/*` 标准库是更高且独立的裁决，不能由 Libraries 包自动获得。

## 标准库资格

反复出现只是开始评估的信号，不是自动晋升。候选能力还必须同时满足：

- 语义与体素、游戏和 OpenVoxel 领域无关。
- 应用包无法合理提供所需的安全、性能或跨目标一致性。
- API 已在真实使用中稳定，而不是为预想场景设计。
- 能承担长期兼容、文档和全目标验证成本。
- 通过独立的 VelarScript 架构裁决，不在 OpenVoxel 或 Libraries 开发中顺手内置。

因此 OpenVoxel 是 VelarScript 的教学项目和证据来源，但不是扩张标准库的后门。

当前实例是后端边界：项目显式激活 `@velarscript/server`，由它组合 `@velarscript/node` 的 ServeApp、WebSocket 与宿主能力，并负责根 `application.*` 的严格有界加载；函数式数据库操作和 SQLite 资源能力仍分别由 `@velarscript-labs/database`、`@velarscript-labs/sqlite` 提供。`@velarscript/server` 只抽象连接的建立、注入与释放生命周期，不拥有具体驱动、模型或查询。OpenVoxel 拥有应用路由、错误信封、配置类型、世界协议、当前表结构、稀疏覆盖事务和服务组合，不把游戏语义写回通用库。
