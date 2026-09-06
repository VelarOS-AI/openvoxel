# ADR 0013：客户端大世界呈现

状态：已接受

## 裁决

客户端世界呈现由四条边界组合：服务端内容目录定义可用方块状态，客户端资源包解析视觉资源，客户端会话维护有界 Chunk 窗口，渲染职责包生成并提交 GPU 网格。渲染器不维护第二份方块编号表，也不把 Babylon 类型泄露给世界、内容或协议包。

进入世界先加载出生点周围 3×3×3 个 Chunk，建立可交互首帧；随后以相机目标所在三维 Chunk 为中心，按由近到远的同心环扩展到 7×7×5。相机在任意轴跨过 Chunk 边界后取消旧请求队列、加载新窗口缺失部分，并从客户端状态和 GPU 同时淘汰远处 Chunk。世界本身仍由确定性生成器按坐标无限寻址；窗口大小只约束客户端驻留量，不成为世界边界。

## 资源与光照

作者格式 v6 让每个逻辑 texture 由一张独立的 32×32 albedo PNG 和一条 YAML 配方维护，并可附加 normal 或 height、ORM material、emissive 单图；manifest 及其 catalog、texture、variant、layer、transform 均使用闭合字段集，图片使用清单只来自验证后的配方。normal、height 与 material 固定为无 ICC profile、非调色板的 8-bit 数据 PNG，emissive 则作为 8-bit sRGB 颜色图归一化，避免数据纹理被隐式颜色管理或量化。缺失通道继续由 surface profile 确定性生成。terrain、vegetation、fluid 是作者资源分类，environment 单独保存非方块环境图像；这些目录只负责维护体验，不决定 GPU 管线。资源构建器遍历最终方块 component profile 及其动画帧闭包，按 opaque、cutout、translucent、fluid 的呈现职责确定性生成 texture bank，material 或 model 名称都不能单独替代这项判定。

每个 bank 同时生成 layer-major 的 albedo、normal、material、emissive 四通道完整 mip 链，四通道共享每一级尺寸、层数与 layer 顺序，并在生成期逐级转换为 GPU 自下而上的行序。这个存储转换只重排 texel，不改变 normal 的通道值；运行时可以关闭 WebGL unpack Y 翻转并逐级上传数组。albedo 与 emissive 在生成 mip 时先转入线性光空间，normal 以切线空间向量平均后重归一化，material 的 AO、roughness、metallic 保持线性平均。cutout 的每个逻辑纹理从实际使用它的材质取得 `alphaCutoff`，据此跨 mip 保持最接近可表达值的覆盖率；同一纹理不能同时服务不同阈值。material 通道按 R=ambient occlusion、G=roughness、B=metallic 编码；逻辑 texture 保存 bank key、生成阈值和带权重的稳定 layer 变体。作者图的空间变换按 base、variant 顺序同步执行，切线法线的 XY 方向随旋转和翻转重映射，颜色调整只改变 albedo，最终四通道 alpha 统一取 albedo。独立作者纹理是可增删改查的资源源，纹理数组仅是确定性构建产物。

生成 artifact v5 的 `textureBanks` 使用 `storage: texture_2d_array`，并把四通道每一级 RGBA8 数组数据嵌入产物。构网仍为每个面写入 0..1 UV，同时以独立的 `textureLayer` 顶点属性选择数组层；纹理层分配不会进入方块目录、世界 runtimeId 或协议身份。动画至少有两个互不重复的帧，全部帧必须处在同一 bank 且各自只有一个 layer，运行时只更新材质的 layer 偏移，不重建 Chunk 网格。资源哈希从规范化的资源清单与分类配方、所有被引用源图的路径和字节、逻辑 texture 到 bank 的最终分配，以及不含自引用哈希字段的资源产物和四通道 mip 字节共同计算；YAML 对象字段顺序及源文件与映射的枚举顺序不会产生伪变更，列表顺序仍保留其变体与动画语义。

运行时要求 WebGL 2，并在创建表面时先验证所有 mip 尺寸、数据、常驻预算，再以设备的 `texture2DArrayMaxLayerCount` 校验每个 bank；不满足能力边界时在提交 GPU 资源前失败。四通道分别上传为 Babylon `RawTexture2DArray`，上下文恢复后从已验证的 CPU 副本重放完整 mip 链；PBR 材质插件通过 `textureLayer` 一次性接入 albedo/alpha、切线空间 normal、AO/roughness/metallic 与 emissive。运行时材质保留 alpha、alpha-cutoff、double-sided、casts-shadows、environment-intensity、clear-coat、clear-coat-roughness 和 unlit 语义；emissive 表达表面自身亮度，世界中的方块光传播仍以方块目录的 light emission 为权威。场景使用天空光、方向太阳、PCF 阴影、色调映射、距离雾和移动云层；资源包可阻止交叉植被把整张透明四边形投成黑影，translucent 网格按视点做有位移阈值和时间节流的 facet 深度排序。

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
- 网格 Worker 只从 `@openvoxel/renderer/meshing-worker` 精确入口启动；该入口与渲染器主入口拥有独立依赖图，不携带 Babylon 表面、PBR 管线或生成的材质纹理资源。
- Worker 初始化时只构造一次 runtimeId 状态索引；网格校验和直接遍历固定缓冲区，不生成 List 快照。
- texture bank 独立打包并共享四通道 layer 布局；Chunk 批次只引用自身职责所需的 bank，并以单独的每顶点 layer 缓冲选择纹理，数组数据不会进入世界或协议数据。
- 每个 texture bank 的单通道完整 mip 链最多 16 MiB；完整资源包的估算常驻量最多 128 MiB，并同时计入 GPU mip、上下文恢复用 CPU 字节和 JSON base64 的保守堆占用。生成、artifact 校验和 GPU 提交使用同一上限。
- 客户端只保留当前 7×7×5 窗口，默认上限 245 个 Chunk。
- 单 Chunk 网格继续受 8 MiB 硬上限保护。
- opaque、cutout、translucent 保持在同一 Babylon rendering group 中共享深度缓冲。
