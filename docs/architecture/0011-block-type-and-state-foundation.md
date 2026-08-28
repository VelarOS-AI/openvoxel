# ADR 0011：方块类型与有限状态地基

状态：已接受

## 目标

OpenVoxel 采用内容、体素、模拟、网格和渲染边界分离的方块模型。方块目录拥有不可变内容契约；世界位置、动态方块实体、执行系统和引擎资源实例位于各自系统。

## 类型、状态与身份

- `BlockTypeSource` 是人工编写的方块家族，以小写命名空间 key 标识，不携带数字 ID。
- `BlockPropertyDefinition` 只允许布尔、有限枚举和有界整数，使全部状态可以在构建时穷举。
- `BlockStateDefinition` 是一个完整属性组合及其物理、光照、渲染、交互和行为描述。
- 规范状态键由方块 key 和按属性名排序的完整属性组成，例如 `openvoxel:oak_log[axis=x]`。
- UInt32 `runtimeId` 是世界内热路径身份。基础目录提供固定低位映射，每世界注册表为 Mod 状态分配高位映射。
- 任意大小或非有限数据进入独立 Block Entity 存储。

属性顺序、YAML 文件顺序和目录分组不改变规范状态键。标签和组件内容不参与状态身份；它们的变化更新 `contentHash`。

## 人工源与生成链

`data/identities.yml` 集中定义运行时代码需要引用的方块、标签、资源和生成器身份。`data/catalog.yml` 声明 schema、目录版本和有序源文件；`data/blocks/` 按 terrain、fluids、minerals 和 vegetation 分组。方块中的 `blocks.water`、`tags.fluid`、`models.block.fluid` 等引用就是 `identities` 树中的实际位置，生成器只按这些路径逐层取值。完整身份树作为开放数据保留；只被 YAML 引用的新路径自动进入产物，VelarScript 直接点访问的核心路径再经过强类型投影。合并结果通过同一套 runtime type 与语义校验，任一路径不存在或任一身份项无人引用都会中止生成。

`npm run generate` 只读取 `data/`，并将身份、完整类型、状态、组件和确定性的基础 `{runtimeId,stateKey}` 映射写入唯一的 `generated/block-catalog.json`。生成产物把相同的物理、光照、渲染、交互和行为组合归并为 `componentProfiles`；状态只保存 `componentProfileId`，运行时装配时再恢复完整不可变快照。

生成结果不回写人工源。空气固定为 0，其余基础状态按规范状态键排序分配。`stateMapHash` 覆盖基础映射；`contentHash` 覆盖完整编译目录。

## 源码分层

`packages/content/blocks/src` 按执行阶段组织：

- `definition/` 定义人工方块、身份树、编译目录和世界快照的数据契约。
- `compiler/` 拥有规范状态键、跨字段验证、状态穷举和目录编译。
- `runtime/` 建立基础目录索引、合成每世界注册表并提供渲染资源查询。
- `index.vel` 汇总包的公开接口；包内测试也通过该入口验证消费者实际使用的 API。

生成工具位于 `tools/`，负责 YAML 与唯一 JSON 产物之间的构建边界；文件读取和 Node 能力不会进入运行时层。

## 组件边界

每个编译状态拥有完整组件描述：

- 物理：碰撞、选择、遮挡形状，可替换性，摩擦和移动倍率。
- 光照：发光、不透明度、天空光模式和环境光遮蔽。
- 渲染：逻辑模型、渲染层、材质、纹理、染色、动画和面剔除。
- 交互：破坏、硬度、爆炸抗性、工具标签、掉落表和声音组。
- 行为：流体、重力、可燃、接触伤害、随机/计划刻、放置与支撑契约。

目录只引用小写命名空间资源 key。标签服务内容分类查询，内建身份通过产物中的 `builtinIdentities` 引用；核心行为使用有类型组件。

状态变体可以按部分属性条件替换完整组件。一个具体状态最多匹配一个变体。

## 世界注册表与 Chunk

`WorldBlockRegistry` 将基础目录、Mod contributions 和已有世界快照合成当前运行时：

- 基础状态位于 `0x00000000..0x00ffffff`。
- Mod 状态从 `0x01000000` 开始按世界追加。
- 已有世界只装配清单锁定的精确 Content Pack 构建和状态集合。

`compileModContentPack` 是 Mod 内容进入世界注册表的标准编译入口。它用一份身份树组合可选的方块和世界生成贡献；方块编译复用基础目录的有限状态展开和语义校验，临时 ID 会在安装到具体世界时重新绑定。

`world-runtime` 通过 `ContentCatalog` 为每个世界解析清单中的 `WorldContentIdentity`。世界打开时以持久化快照为数字身份权威重新合成活动注册表；哈希或状态集合不一致时拒绝打开。

Chunk 的 `palette` 保存 UInt32 世界运行时 ID，4096 个 `indices` 使用 UInt16 局部索引。生成、网格和状态模拟通过注册表解释调色板项。

## 强制验证

构建拒绝非法命名空间 key、重复类型/状态/标签/行为、非法默认状态、属性笛卡尔积过大、非法 UInt32、无效形状、越界光照、非法资源引用、缺少流体属性、重叠状态变体和错误空气定义。测试覆盖生成确定性、组件档案归并、核心语义标签、状态转换、Mod 编译与分配、精确内容装配和 Chunk 调色板。
