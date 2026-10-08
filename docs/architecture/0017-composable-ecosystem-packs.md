# 可组合的世界生态包

世界由一个受保护的生成内核和一组具名内容包组装。创建世界时选择内容包，存档记录排序后的包身份与内容哈希；打开世界时必须能解析到相同构建。切换组合用于创建新世界，避免同一个存档的新旧区块采用不同生态。

## 已安装内容

| 包 | 内容 |
| --- | --- |
| terrain | 大陆/平坦/岛屿地形接口、区域划分、土层、道路、水文、洞穴、含水层、植被和矿物阶段 |
| biomes | 12 种陆地群系及区域过渡 |
| woodland | 橡树、白桦、云杉、高云杉、合欢、杨树、倒木与藤蔓 |
| understory | 草丛、野花、树苗、蘑菇、蕨类、野生作物与仙人掌 |
| aquatic | 海带、水草、海胆、海星 |
| minerals | 煤、铜、铁、硝石、硫、钻石、锗 |
| orchard | 樱花树、苹果树、梨树、桃树；樱花林和果园群系 |
| berries | 蓝莓、树莓、黑莓灌丛和草莓，带生长状态 |
| gourds | 西瓜和瓜藤 |
| botanical | 竹林、花野、薰衣草、向日葵、绒球葱、铃兰和三叶草 |
| wetlands | 垂柳、香蒲、芦苇、蓝色兰花及柳树湿地 |
| geology | 金矿、绿宝石矿和紫水晶矿体 |

原有树木、地表植物、水生物和矿物也从单元表注入，使用同一条组合路径。基础包定义在 `packages/world/generation/data/packs/`；扩展包定义在 `packages/content/packs/data/`。全部启用时共有 17 种陆地群系、11 个树木单元、42 个植物单元、10 个矿物单元。海洋、海岸和河道由地貌与水文阶段确定。

## 核心和扩展边界

核心负责区块布局、世界高度、基础材料语义、随机子流、状态编号、缓存、跨区块所有权、存档和协议验证。注册表对提交数据和查询结果分别建立独立副本，外部修改原始对象或返回值不会改变已注册内容。生态包是有界数据，不携带可执行脚本，不持有生成器闭包或存储对象。`core`、`openvoxel.core` 和基础 `openvoxel` 包命名空间受保护。

公开单元域为 `biomes`、`trees`、`plants`、`minerals`、`features`、`stages`。阶段只接收对应领域的配置；原始 YAML/JSON 的顶层能力字段和阶段字段采用白名单。内核验证配置数值、模板尺寸、矿脉高度、物种状态和材料引用。树模板限定水平半径 4、相对高度 1–23；陆生植物最高 6 格；矿物从 Y=5 开始，保留基础地层。

地形阶段实现目前提供 `continental`、`flat`、`islands` 三种。要增加新的可执行算法，需要在内核审查后增加公开实现，再由包选择；普通生态作者用数据组合与模板扩展。运行中热换包不属于接口：包选择是世界创建时的固定事实。

## 编写与组合

每个扩展目录使用 `content.yml`、`identities.yml`、`blocks/catalog.yml`、`blocks/*.yml`、`ecosystem.yml` 和 `resources.yml`。已有六个扩展目录可直接作为完整示例。将目录名加入 `packages/content/packs/data/catalog.yml`，运行根目录 `npm run generate`，即可生成内容产物、菜单描述和包含相应材质的资源包。YAML 编译 API 位于 `@openvoxel/world-generation/compiler`，运行时入口只处理已编译数据。贴图源和哈希记录在渲染包的 `data/flora-texture-source.md`。

包内的 `ecosystem.yml` 结构如下：

```yaml
formatVersion: 1
owner: mygarden
title: 我的花园
description: 自定义温带生态
requires: [terrain]
replaces: []
removes: []
units:
  biomes: []
  trees: []
  plants: []
  minerals: []
  features: []
  stages: []
```

新增单元使用自身命名空间，如 `mygarden:rose`。替换已有单元需要在 `requires` 明确依赖当前所有者、在 `replaces` 列出原键，并提供相同域的完整新单元。去掉某个单元使用 `removes`。多个独立包争夺同一单元会报冲突；需要叠加替换时，后一个包必须显式依赖前一个包。加载顺序由依赖与 owner 排序确定，调用方输入顺序不影响结果。

群系用温度、湿度、权重、林冠覆盖率、地表覆盖率、起伏和抬升构成区域生态。`family` 决定土层等公共环境语义，例如 `openvoxel:biome/forest`；物种亲和度优先匹配具体群系，再匹配其 family。树木支持公共树形或有界体素模板，以及树冠下的果实。植物可以定义支撑标签、状态选择、上下部材料和高度；水生植物可声明盐水限制及距水面留白。矿物声明基岩材料、层位、概率和矿脉大小。

`createWorldGeneratorRegistry(packs=[])` 可获得空生态基础生成器；`packs=[...]` 只组装指定单元。默认基础世界从六个基础生成包组装。客户端新建世界默认勾选全部已安装包，菜单保留地貌包，其他包可独立开关。服务器的 `content.defaultPacks` 使用明确的 owner 列表选择默认组合。

## 渲染与确定性

内容哈希覆盖生态配置和方块定义。渲染产物记录支持的包 owner/hash，接收世界内容时逐项验证，同时复算整个内容集合的身份。所有启用组合使用同一资源解析路径。资源清单和四个纹理分组拆成独立 JSON 模块，完整可分发产物仍保留为 `client-resource-pack.json`。

树木、倒木与高植物由世界坐标所有者生成，再裁剪到各区块；特征互斥采用完整体素集合。生长、随机状态与地下矿物也由相同种子和包配置决定。验证包含包顺序无关、缺失依赖、替换冲突、越权字段、独立包组合、资源身份以及跨区块连续性。

视觉巡览：先构建相关工作区，再运行 `npm run test:terrain -- ecosystem --packs --regions --sites=cherry_grove,orchard,bamboo_forest,flower_fields,willow_marsh`。截图和物种计数写入游戏工作区的 `generated/terrain-tour/ecosystem/`。
