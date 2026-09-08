# ADR 0013：客户端大世界呈现

状态：已接受

## 裁决

客户端世界呈现由四条边界组合：服务端内容目录定义可用方块状态，客户端资源包解析视觉资源，客户端会话维护有界 Chunk 窗口，渲染职责包生成并提交 GPU 网格。渲染器不维护第二份方块编号表，也不把 Babylon 类型泄露给世界、内容或协议包。

VelarScript 文件只定义 OpenVoxel 的强类型表面、纯策略和组合根；Babylon、DOM、WebGL 与原生事件实现按 surface、texture-bank、environment、navigation 职责位于 `src/native/babylon/*.mjs`，通过 package `imports` 和 `extern module` 接入。每个 JS 入口在自己的主机边界校验参数，对外仍只返回 OpenVoxel 契约，不在 JS 中复制移动或世界规则。

进入世界先加载出生点周围 3×3×3 个 Chunk，建立可交互首帧；随后以全方向半径二的安全球和半径五的完整三维前向视区组成新驻留需求。已有数据使用半径三/六的释放迟滞，转头后可复用刚离开视区的数据。同一 x/z 列的垂直 section 连续请求，使生成器复用一次地形列规划。任一轴跨过 Chunk 边界后只保留最新窗口需求；正在完成的一个小批次不反复取消，批次 load 成功后必须先提交与它配对的 unload，再响应更新的视窗版本。世界本身仍由确定性生成器按坐标寻址；窗口大小只约束客户端驻留量，不成为世界边界。

冷地形到达只建立可组合的 Chunk 状态，不能单独触发构网；首次非过期的完整增量被接受后才表示冷热状态同步完成。即使该增量是 `revision = 0` 且没有覆盖项，新 Chunk 也必须恰好发布一次同步完成事件，随后相同快照不重复使网格失效。这样初始窗口与后续流送窗口共享同一就绪语义，不依赖页面启动时的额外遍历兜底。

## 世界模式与探索控制

`WorldManifest.mode` 是游戏模式的权威事实，与生成器及内容身份一起持久化并经协议传递；首页缓存只负责展示。Renderer 只把这个领域事实投影为移动策略：Survival 使用带重力、碰撞、跳跃、台阶和冲刺的第一人称步行，Creative 使用第一人称自由飞行。页面深链、重新打开、本地 Worker 和线上后端都从同一份 Manifest 选择策略，不根据页面入口或本地缓存猜测模式。

Creative 的连续位置与速度更新属于纯 VelarScript 策略；它统一归一化三轴输入、限制加速度与制动、钳制世界高度，并把单帧积分限制在 50 ms，避免后台页面恢复时瞬移。Babylon/DOM 适配器只拥有 UniversalCamera、指针锁、鼠标增量、键盘状态和监听器生命周期：点击 Canvas 捕获指针，WASD 平移，Space 上升，Ctrl/C 下降，Shift 加速，Esc 由浏览器释放指针。失焦、指针锁丢失、页面隐藏和表面释放都会原子清空按键与三轴速度；释放表面还必须移除全部监听器并归还指针锁。异步指针锁请求以表面代次校验所有权；已释放表面的迟到完成只能退出其自身 Canvas 的锁，不能释放后来表面取得的锁。

适配器每帧把相机水平朝向投影为纯策略的正交单位基，并把返回的新状态一次性提交给 Camera。位置跨过 Chunk 边界或视向显著变化时通知 Web 世界渲染器；位置与完整三维 forward 同时驱动 Chunk 窗口、环境采样、Portal 可见性、局部阴影和透明面排序。数据窗口只在累计转向约 15 度后刷新。Babylon 只提供相机事实，窗口和优先级仍由渲染组合根决定。Babylon 对象、DOM 事件与可变按键集合均不得越过适配器进入世界模型或移动策略。

## 可见性与高度需求

Chunk 数据驻留与可见网格需求是两条不同边界，不能用视锥替代世界真相：

- `resident safety` 使用全方向半径二的近邻球，不依赖朝向，为碰撞、编辑和跨 Chunk 构网提供数据；未知区域阻止生存玩家继续穿入。
- `visible candidates` 使用完整三维 forward、半径五的扩张球锥和前向优先级；先从驻留数据中选择当前候选，再进入 Portal。
- `portal visible` 从相机所在 section 做六面开放区域的保守 BFS，只决定昂贵的构网与 GPU 上传。未知、失效或计算失败的摘要一律按可见且可连通处理，因此优化最多产生额外绘制，不能产生地形空洞。

每个 section 的联通摘要由 Mesher 的 `state.occludes` 事实生成，记录六面是否开放和非遮挡连通分量可到达的面矩阵；叶、水和玻璃可连通，碰撞盒与 `cullFaces` 不能替代遮挡语义。当前面级摘要允许相邻孔洞不重合时多画。离散球锥边缘的几何孤岛、尚未驻留的相机中心和未知摘要都按可见处理。方块编辑使本 section 摘要和网格失效，边界编辑同时重构相邻网格。

高度方向先受安全球和完整三维视区约束。生成器用全局自然地表上界证明极高 section 为空并跳过地形列规划；其他 section 再用列内最高地表、海面和装饰上界跳过空气生成扫描。客户端已有数据的 Portal 摘要继续裁剪构网和上传。若要在传输前跳过整段列数据，协议还必须同时发布生成列包络和持久化修改的垂直分布，保证玩家建筑仍被加载。

## 资源与光照

作者格式 v9 让每个逻辑 texture 由一张独立的 32×32 albedo PNG 和一条 YAML 配方维护，并可附加 normal 或 height、ORM material、emissive 单图；manifest 及其 catalog、texture、variant、layer、image reference、transform、环境资源均使用闭合字段集，图片使用清单只来自验证后的配方。normal、height、material 与 mask 固定为无 ICC profile、非调色板的 8-bit 数据 PNG，emissive 则作为 8-bit sRGB 颜色图归一化，避免数据纹理被隐式颜色管理或量化。缺失通道继续由 surface profile 确定性生成。terrain、vegetation、fluid 是作者资源分类，environment 按 sky 与 weather 保存非方块环境图像；这些目录只负责维护体验，不决定 GPU 管线。资源构建器遍历最终方块 component profile 及其动画帧闭包，按 opaque、cutout、translucent、fluid 的呈现职责确定性生成 texture bank，material 或 model 名称都不能单独替代这项判定。

每个 variant 可按声明顺序叠加至多四个完整 material layer。每层拥有独立 albedo，可选 normal 或 height、ORM material、emissive、灰度乘 alpha mask、局部 transform、opacity 和 albedo blend。base 与 layer 的局部空间变换先作用于 albedo 及作者 map，height 变换完成后才生成切线法线；缺失通道也从变换后的 albedo 生成。随后各层用统一覆盖率合成：albedo 在线性光空间混合；切线法线执行 whiteout detail blend 后归一化；AO 相乘，roughness 与 metallic 插值；emissive 在线性光空间相加并钳制。variant transform 最后作为全局变换作用于合成 surface，颜色操作只改变 albedo，空间操作保持各通道配准并重映射法线方向。

资源审计 artifact v4 会按 texture key、variant index 和最终 bank layer 逐项记录四个 PBR 通道的 authored、generated 或 composed 模式，并保留 composed 通道的输入来源类型；它还记录环境图片的解码/GPU 字节、Base64 堆占用和整个资源包的统一常驻预算。这是构建诊断身份，不进入运行时资源协议。

每个 bank 同时生成 layer-major 的 albedo、normal、material、emissive 四通道完整 mip 链，四通道共享每一级尺寸、层数与 layer 顺序，并在生成期逐级转换为 GPU 自下而上的行序。这个存储转换只重排 texel，不改变 normal 的通道值；运行时可以关闭 WebGL unpack Y 翻转并逐级上传数组。albedo 与 emissive 在生成 mip 时先转入线性光空间，normal 以切线空间向量平均后重归一化，material 的 AO、roughness、metallic 保持线性平均。cutout 的每个逻辑纹理从实际使用它的材质取得 `alphaCutoff`，据此跨 mip 保持最接近可表达值的覆盖率；同一纹理不能同时服务不同阈值。material 通道按 R=ambient occlusion、G=roughness、B=metallic 编码；逻辑 texture 保存 bank key、生成阈值和带权重的稳定 layer 变体。最终四通道 alpha 统一取合成 albedo。独立作者纹理是可增删改查的资源源，纹理数组仅是确定性构建产物。

生成 artifact v8 的 `textureBanks` 使用 `storage: texture_2d_array`，把四通道每一级 RGBA8 数组数据与完整环境 WebP 资源嵌入产物。构网仍为每个面写入 0..1 UV，同时以独立的 `textureLayer` 顶点属性选择数组层；纹理层分配不会进入方块目录、世界 runtimeId 或协议身份。bank 角色由已解析模型的 `kind` 与渲染层决定，不依赖某个内建模型资源 key。动画至少有两个互不重复的帧，全部帧必须处在同一 bank 且各自只有一个 layer，运行时只更新材质的 layer 偏移，不重建 Chunk 网格。资源哈希从规范化的资源清单与分类配方、所有被引用源图的路径和字节、逻辑 texture 到 bank 的最终分配，以及不含自引用哈希字段的资源产物和四通道 mip 字节共同计算；YAML 对象字段顺序、texture catalog 及其中独立 texture 条目的声明顺序、源文件与映射的枚举顺序不会产生伪变更，variant、material layer 与动画帧等有语义列表仍保留声明顺序。

运行时要求 WebGL 2，并在创建表面时先验证所有 mip 尺寸、数据、常驻预算，再以设备的 `texture2DArrayMaxLayerCount` 校验每个 bank；不满足能力边界时在提交 GPU 资源前失败。四通道分别上传为 Babylon `RawTexture2DArray`，上下文恢复后从已验证的 CPU 副本重放完整 mip 链；PBR 材质插件通过 `textureLayer` 一次性接入 albedo/alpha、切线空间 normal、AO/roughness/metallic 与 emissive。运行时材质保留 alpha、alpha-cutoff、double-sided、casts-shadows、environment-intensity、clear-coat、clear-coat-roughness、unlit 和 precipitation-surface 语义；emissive 表达表面自身亮度，世界中的方块光传播仍以方块目录的 light emission 为权威。场景使用动态天空与 IBL、天空光、太阳和月亮方向光、PCF 阴影、色调映射、天气距离雾、固定世界尺度的云穹顶、雨雪与溅射粒子和确定性闪电；资源包可阻止交叉植被把整张透明四边形投成黑影，translucent 网格按视点做有位移阈值和时间节流的 facet 深度排序。

OpenVoxel 的分类 YAML、独立 PNG 和生成产物共同构成客户端资源权威，服务端内容目录仍是方块状态权威。两者只通过逻辑资源 key 联结，不复制数字方块映射，也不把 Babylon 对象写入内容或世界模型。

## 环境权威与呈现

`@openvoxel/world` 拥有降水、闪电、环境状态、时空样本不变量和纯函数时间线。
它以 `seed + worldMilliseconds + samplePosition` 随机访问计算二十分钟昼夜周期、
八个月相、512 方块格点间连续的云量/风/降水、2048 方块尺度的气候温度、海拔温降
以及绑定稳定空间 cell 的闪电事件。运行时与会话默认以出生点采样，客户端视窗移动后
改用当前流送中心。`WorldManifest.worldTimeOriginMilliseconds` 保存世界时间零点；
创建瞬间对应正午，默认采样以 Core 的 `velar/time.now()` 减去该原点得到世界时间，
测试可以注入时钟或显式传入世界时间。SQLite 与 IndexedDB 持久化同一原点，因此世界
关闭和重新打开后仍连续推进；天气样本不持久化，也不进入方块事件 sequence。

Server 与 Local Worker 都在 `world.ready` 中发送同一权威样本。`ClientWorldSession`
验证样本结构与跨字段语义，再记录 `monotonic()` 锚点；Web 渲染器以 100 ms 周期
按当前视点取得新样本并更新表面，重连则换用新的权威时间锚点。Renderer 只把
样本投影为天体方向、天空/地平线/地面颜色、光照强度、动态立方环境贴图、雾、云和
粒子参数；权威 `windX/windZ` 同时驱动云层相位与雨雪的水平漂移。闪电年龄取 `worldMilliseconds - occurredAtWorldMilliseconds`，重复应用同一
事件不会重新播放，渲染帧率也不会改变其寿命。天空、灯光、雾和天气跟随每个样本；
需要重算六面像素并上传 GPU 的 IBL 只在太阳方向累计变化至少 2 度，或关键强度、
天空颜色累计跨过 1/32 时刷新。阈值始终相对上次 IBL 帧计算，小变化会累积而不会丢失。雨滴溅射高度由当前已提交 terrain Mesh 的向下射线取得；有效候选和精确 XZ 命中按水平 Chunk 柱缓存。区块替换或卸载立即失效对应地表探针缓存；同一水平柱连续提交多个垂直 section 时，天气列刷新在渲染帧内合并，静默 32 ms 或最迟 64 ms 后执行一次。无地面命中时关闭溅射，避免在虚空高度制造平面雨花。

### 环境贴图的采样契约

环境 WebP 保留作者预乘 RGB。日月、云和雨雪的无光材质直接输出 `texture × vertexColor × tint`，使用 `ONE / ONE_MINUS_SRC_ALPHA`；淡出同时缩放 RGBA，透明顶点为透明黑。光晕与星星使用 `SRC_ALPHA / ONE` 加法混合。所有环境图使用单 mip；天空图使用 LinearClamp，云使用 LinearWrap，降水与落地粒子使用 PointClamp。图片上传翻转 Y 后，几何 UV 显式补偿 V，包含月面细节与雪花格方向。

贴图用法参考本地 Survivalcraft 的 `SubsystemSky`、`PrecipitationShaftParticleSystem`、`RainSplashParticleSystem` 与 `SnowSplashParticleSystem`，由 OpenVoxel 的渲染适配层实现：

| 资源 | 呈现规则 |
| --- | --- |
| Sun / 八张 Moon | 距离 900，太阳半径 90–160、月亮 60–80，随日出日落放大；固定轨道切面，月相直接选图 |
| SkyGlow / Star | 日月各有 3.5 倍光晕；250 颗确定性星星覆盖全天球并随时间转动 |
| Clouds | 7×7 四环穹顶，半径 1900、顶高 600、边高 60；世界 UV 周期 `1900/1.75`，保留每秒 0.002 周期的基线并叠加权威风场；中心天光、边缘地平线色、外环透明 |
| Rain | 宽 0.04、高 0.30 的竖直三角形，8–12 方块/秒，风致水平速度最多 2 方块/秒，顶端淡入，密度响应降水强度 |
| Snow | 4×4 图集固定格、宽高 0.14，0.5–3 方块/秒，风致水平速度最多 0.75 方块/秒；生命周期内保持格子和形状 |
| RainSplash / 落地 Snow | 只由真实表面碰撞生成；雨在水上扩环、硬地弹起，雪保留原格水平贴地，落水后更快消失 |

材质显式声明 `precipitationSurface: none | solid | water`。最高有效地形命中决定落地表现，装饰 cross 为 none；不能从方块编号、气候 tint 或透明度推断水面。每帧最多采样 16 列，整个天气场最多 149 列，每列四个降水槽；雨溅射 150、落地雪 100 的固定池复用四个 GPU 批次。雨雪的水平位置在所属 1×1 地面采样列内循环，强风和慢速雪花不会越出碰撞事实的所有权。动态绘制范围与包围盒同步维护；大幅垂直移动立即重新填充眼高窗口，不产生旧位置碰撞。

云层风位移只在相邻权威环境样本之间按梯形积分，并以五秒作为一次积分上限；重复样本不改变状态，时间回退或长时间暂停只替换锚点。渲染帧仅从最新锚点按 `worldMilliseconds` 纯外推，因此同一权威帧的重复应用和闪电逐帧更新都不会把风重复积分，也不会把绝对世界时间放大成 UV 跳变。

天空深度固定在远端且不写深度，使云与天体的几何尺度独立于地形视距；地形深度继续遮挡环境，不扩张地形相机的 far plane。世界时间、季节天文、环境权威样本、动态 IBL 和地面阴影仍沿用各自职责。GPU 门禁除截图外，还用已知预乘 texel 验证真实混合结果和零淡出的 RGB，防止重复乘 alpha 再次进入管线。

## 季节与地表生态

气候属于世界模型：`worldClimateAt(seed, worldMilliseconds, position)` 返回季节、年内进度、摄氏温度、湿度、积雪覆盖率与冻结状态。每季八个世界日，全年三十二日；新世界从仲春正午开始。连续空间气候场、季节温差与海拔温降共同决定采样结果，降水形态与自然冰雪使用同一份温度规则。太阳轨道也使用同一年度相位，夏季日长、冬季太阳低。

生成器负责缓存自然露天地表候选，Runtime 按三十秒世界时间槽把候选投影为冰、水、雪或空气，再叠加持久化玩家修改。存储中的玩家方块具有最终优先权；自然冰雪可以融化，玩家放置的冰雪保持原样。屋顶判定读取同一水平列上方的持久化修改，不能把客户端尚未驻留的建筑当作空气。组合增量携带独立的 `ecologyEpoch`，不为自然换季消耗玩家修改的 revision 或事件 sequence。客户端拒绝旧 revision 或旧生态时间槽的完整快照。

客户端会话以独立的有界刷新队列每次最多同步四个已驻留 Chunk；时间槽更新和相关列的玩家编辑触发检查，方块内容保持相同时不使网格失效。碰撞、渲染与编辑的 previous 值都读取组合后的同一份方块状态。

当前生态候选覆盖种子生成的自然露天地表；玩家屋顶与支撑修改会抑制这些候选。玩家新建表面、砍伐树冠后新露出的下层地表，需要后续的分层支撑与天顶遮挡摘要来建立新候选。

资源 tint 显式声明 `climate`（none、grass、foliage、water）与 `coverage`（all、grass_cap）。artifact v8 和 Chunk 顶点 `tintRoles` 传递此视觉职责，不依赖资源 key 拼写，也不改变方块 runtimeId。草地侧面只给绿色草帽染色，泥土保持作者颜色；草叶保留原始明暗细节，法线、粗糙度和高光通道保持配准。GPU 对共享的八角气候样本做三线性插值，十五秒时间槽只更新材质参数，不重建网格。采样节点与 Chunk 参数缓存各有固定容量，跨水平和高度 Chunk 边界共享格点。

## 网格与面剔除

每次构网输入包含目标 Chunk 和一格邻域，跨 Chunk 边界与内部边界执行相同判断：

- 不透明完整体积遮挡相邻方块面。
- 同渲染层、同材质且声明 `cullFaces` 的 cube/column 共享内部边界，即使树叶种类或 runtimeId 不同。
- cutout 不遮挡相邻不透明方块；cross 植物没有完整体积，不能参与内部面剔除。
- 相同透明体积共享内部边界；流体液位不同时只保留露出的侧面。
- 盒模型先判断自身表面与相邻格的模型表面是否真正接触：仙人掌内缩侧面不会被隔空剔除，低于格顶的雪面不会被上方实体剔除；相邻雪层按实际高度移除共享部分，只提交高出邻居的侧面条带。

后台内容目录中的每个非空气状态都必须通过真实 RenderCatalog 解析，并在隔离体素测试中至少生成一个批次和一个可见面。这样新增方块若缺模型、材质、纹理或网格实现，会在资源生成或测试阶段失败，而不是进入世界后静默消失。

## GPU 验收边界

渲染职责包维护一个仅在测试期间由临时 HTTP 服务承载的无头 GPU 探针，不注册产品路由，也不进入正式前端导航。探针从后台的完整状态目录和内建客户端资源包动态建场景，经公开 RenderCatalog、Chunk mesher、Babylon 表面和真实 WebGL 2 `Texture2DArray` 链路提交，而不是复制一套测试渲染器。

探针必须覆盖全部可见 runtime state、每个纹理数组 layer 及四个 PBR 通道、动画帧、opaque 与异种树叶的跨 Chunk 接缝，以及 water、magma、ice 与不透明几何共同出现时的双视角透明排序。环境场景另覆盖白昼、夜晚、云层、雨、雪和闪电，断言日月星可见性、粒子活动、事件重放身份及场景截图差异。树叶阴影场景把同一 cutout 材质放入两个 Chunk，既检查共享阴影 Effect 与销毁后的零残留引用，也以临时实心阴影为反例，从实际地面像素证明 alpha 镂空参与投影。验收同时检查 GPU 网格统计、纹理层闭包、浏览器 console/page error、上下文丢失恢复和分区图像度量，并把截图写入忽略版本控制的 `generated/gpu-render-probe` 作为本次运行证据。Web UI 长距离移动验收主动请求浏览器硬件加速并记录实际 renderer；只有硬件后端承担生产帧预算，SwiftShader 回退只验证进度与工作量有界，不能用 CPU 光栅帧时间冒充产品 GPU 性能。根级 `test:gpu` 可独立执行 GPU 门禁，完整 `validate` 在生产构建后再次执行两类浏览器验收。

## 性能约束

第一人称环境探针另以仰视相机检查云穹顶的四环高度、世界采样尺度和透明混合，并在平视画面的中间视野带对比雨雪粒子开关。四季探针在同一组 GPU Mesh 上更新时间，检查草叶像素变化与 Mesh 身份不变；阴影探针对比投影开关，验证地面实际变暗而不只统计 caster 数量。

- 首页、创建和世界管理路由不静态导入世界页。世界页通过 `velar/web.lazy`
  形成显式 split point，因此 Babylon、生成的资源包和渲染组合根只在进入世界后加载。
- Babylon 原生适配器从具体职责模块导入所用类型，并显式导入碰撞协调器等必要注册项；
  不从 `@babylonjs/core` 聚合入口拉入未使用的引擎、材质、加载器和 shader 注册图。
- 首帧下载与远景流式加载分离，单次流式提交最多 4 个 Chunk，限制反序列化和状态合入的同步突发。
- ticket 在 Renderer 生命周期内单调且不复用；GPU 物理安装和内容新鲜度分别记录。编辑、邻区加载和视窗淘汰都会使旧结果失效；迟到提交会重建或显式释放。邻区卸载还会重建仍驻留的六面邻居，让原先被剔除的共享面重新外露。
- Meshing 生命周期维护自己的驻留位置表；Portal 候选 key、六邻接和几何连通只在视向或驻留拓扑变化时重建。单个网格摘要提交只复用整数队列、代次标记和面掩码重跑 reachability，不重新快照世界位置或构造候选图。
- 网格 Worker 由一个有界池统一调度；资源目录通过池级广播只初始化一次，视窗任务的取消信号继续传入 Chunk 下载、热增量同步和本地生成循环。
- 网格 Worker 只从 `@openvoxel/renderer/meshing-worker` 精确入口启动；该入口与渲染器主入口拥有独立依赖图，不携带 Babylon 表面、PBR 管线或生成的材质纹理资源。
- Worker 初始化时只构造一次 runtimeId 状态索引；网格校验和直接遍历固定缓冲区，不生成 List 快照。
- 客户端 Chunk 保留 UInt16 冷索引，并为驻留期一次展开由热增量维护的 UInt32 组合视图；16³ Chunk 增加 16 KiB 常驻读取缓存，换取碰撞与重复构网不再逐格访问 override Map 和 palette。邻域快照复用调用方已经捕获的中心 Chunk，并在进入体素循环前各读取一次中心与六邻居的线性读取函数。
- 动态天空与天气可按 100 ms 权威样本更新；动态立方 IBL 使用可见变化阈值，不在每次样本刷新时重算并上传六个面。
- 降水使用相机周围有界列场，每帧最多补齐 16 列；通过水平 Chunk 柱索引只检测目标 terrain Mesh，并复用该柱候选和精确 XZ 命中。缓存容量随驻留柱释放；地表探针随区块发布、替换和卸载同步失效，同一水平柱的天气列、粒子与落点刷新在 32 ms 静默窗口内去重，并以 64 ms 为硬上界，再按原预算重采样。
- 方向光关闭每帧自动包围盒扩展，使用固定阴影视锥；完整 caster 所有权与相机附近约三 Chunk 的活动阴影集合分离，只有活动成员真正改变时才使阴影缓存失效。相机投影、太阳方向与网格失效以 100 ms 最小间隔合并，并在同一帧原子提交灯光矩阵和 2048 PCF 阴影图；上下文恢复仍立即刷新一次。cutout 材质保留 Babylon 的 alpha shader 注入与逐 SubMesh draw state，但阴影程序身份按原始 Effect 复用；Mesh 或材质释放时同步清除观察者、内部索引和 Effect 引用。
- texture bank 独立打包并共享四通道 layer 布局；Chunk 批次只引用自身职责所需的 bank，并以单独的每顶点 layer 缓冲选择纹理，数组数据不会进入世界或协议数据。
- 每个 texture bank 的单通道完整 mip 链最多 16 MiB；完整资源包的估算常驻量最多 128 MiB，并同时计入纹理数组 GPU mip、上下文恢复用 CPU 字节、环境图片解码后的 GPU 字节以及 JSON/Data URL Base64 的保守堆占用。生成、artifact 校验和 GPU 提交使用同一上限。
- 水平轴向的新窗口为 240 个 section；任意视角的新获取需求上界为 274，迟滞驻留上界为 524，含单批提交的瞬时驻留上界为 528。每批成功后必须先淘汰配对旧项，再检查目标版本。队列按 key 保留最新值，两个构网 Worker 各最多等待一个逐帧 GPU 上传。
- world-runtime 的每次批量读取会持有扫描时已命中的 readonly 增量快照；同批缺失项在等待存储期间即使因 Chunk 数量或 override 预算触发 LRU 淘汰，也不会破坏这次读取的完整性。
- 单 Chunk 网格继续受 8 MiB 硬上限保护。
- opaque/cutout、天体与云、translucent terrain、雨雪/溅射、闪电按 0..4 分组，并显式保留组间深度；透明地形仍受不透明深度遮挡，天气在透明地形之后合成。
