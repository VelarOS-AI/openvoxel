# ADR 0013：客户端大世界呈现

状态：已接受

## 裁决

客户端世界呈现由四条边界组合：服务端内容目录定义可用方块状态，客户端资源包解析视觉资源，客户端会话维护有界 Chunk 窗口，渲染职责包生成并提交 GPU 网格。渲染器不维护第二份方块编号表，也不把 Babylon 类型泄露给世界、内容或协议包。

进入世界先加载出生点周围 3×3×3 个 Chunk，建立可交互首帧；随后以相机目标所在三维 Chunk 为中心，按由近到远的同心环扩展到 7×7×5。相机在任意轴跨过 Chunk 边界后取消旧请求队列、加载新窗口缺失部分，并从客户端状态和 GPU 同时淘汰远处 Chunk。世界本身仍由确定性生成器按坐标无限寻址；窗口大小只约束客户端驻留量，不成为世界边界。

## 资源与光照

每个逻辑 texture 由一张独立的 32×32 PNG 和一条 YAML 配方维护。terrain、vegetation、fluid 是作者资源分类，environment 单独保存非方块环境图像；这些目录只负责维护体验，不决定 GPU 管线。资源构建器遍历最终方块 component profile 及其动画帧闭包，按 opaque、cutout、translucent、fluid 的呈现职责确定性生成 texture bank，material 或 model 名称都不能单独替代这项判定。

每个 bank 同时生成带边缘填充、mipmap 配置和完全相同像素布局的 albedo、normal、material、emissive 四张图集。material 图按 R=ambient occlusion、G=roughness、B=metallic 编码；逻辑 texture 只保存 bank key、带权重的 UV 变体，方块网格因此仍只需要一套 UV。动画的全部帧必须处在同一 bank 且拥有相同区域尺寸，运行时同步平移四张图集的采样区域，不重建 Chunk 网格。

`textureBanks` 是资源产物与渲染后端之间的存储抽象。当前 format v4 使用 `storage: atlas`，由 Babylon `PBRMaterial` 直接消费生成图集；以后可以增加 `texture_2d_array` 后端而不改变逻辑 texture、方块目录或世界 runtimeId 的身份边界。资源哈希覆盖作者 PNG、YAML 配方、bank 分配、四通道生成结果和环境资源。

运行时材质保留 alpha、alpha-cutoff、double-sided、casts-shadows、environment-intensity、clear-coat、clear-coat-roughness 和 unlit 语义。逐像素的凹凸、粗糙度、金属度和自发光来自对应 bank；emissive 表达表面自身亮度，世界中的方块光传播仍以方块目录的 light emission 为权威。场景使用天空光、方向太阳、PCF 阴影、色调映射、距离雾和移动云层；资源包可阻止交叉植被把整张透明四边形投成黑影，translucent 网格按视点做有位移阈值和时间节流的 facet 深度排序。

OpenVoxel 的分类 YAML、独立 PNG 和生成产物共同构成客户端资源权威，服务端内容目录仍是方块状态权威。两者只通过逻辑资源 key 联结，不复制数字方块映射，也不把 Babylon 对象写入内容或世界模型。

## 网格与面剔除

每次构网输入包含目标 Chunk 和一格邻域，跨 Chunk 边界与内部边界执行相同判断：

- 不透明完整体积遮挡相邻方块面。
- 同渲染层、同材质且声明 `cullFaces` 的 cube/column 共享内部边界，即使树叶种类或 runtimeId 不同。
- cutout 不遮挡相邻不透明方块；cross 植物没有完整体积，不能参与内部面剔除。
- 相同透明体积共享内部边界；流体液位不同时只保留露出的侧面。

后台内容目录中的每个非空气状态都必须通过真实 RenderCatalog 解析，并在隔离体素测试中至少生成一个批次和一个可见面。这样新增方块若缺模型、材质、纹理或网格实现，会在资源生成或测试阶段失败，而不是进入世界后静默消失。

## 性能约束

- 首帧下载与远景流式加载分离，单次流式提交最多 12 个 Chunk。
- 同一 Chunk 只接受最新 ticket 的 Worker 结果；编辑、邻区加载和视窗淘汰都会使旧结果失效。
- 网格 Worker 由一个有界池统一调度；资源目录通过池级广播只初始化一次，视窗任务的取消信号继续传入 Chunk 下载、热增量同步和本地生成循环。
- Worker 初始化时只构造一次 runtimeId 状态索引；网格校验和直接遍历固定缓冲区，不生成 List 快照。
- texture bank 独立打包并共享四通道布局；Chunk 批次只引用自身职责所需的 bank，生成图像不会进入世界或协议数据。
- 客户端只保留当前 7×7×5 窗口，默认上限 245 个 Chunk。
- 单 Chunk 网格继续受 8 MiB 硬上限保护。
- opaque、cutout、translucent 保持在同一 Babylon rendering group 中共享深度缓冲。
