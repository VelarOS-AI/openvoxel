# Cloudflare Pages 部署

正式地址：[openvoxel-velaros.pages.dev](https://openvoxel-velaros.pages.dev/)。

OpenVoxel 的网页使用浏览器 Worker 生成世界，世界存档保存在当前站点的 IndexedDB。
部署目录只包含静态文件，使用 Cloudflare Pages Direct Upload；[Cloudflare 官方说明](https://developers.cloudflare.com/pages/get-started/direct-upload/)确认它支持从本机重复上传构建产物。每个域名的浏览器存储相互独立。

首次使用时，在 Cloudflare 账户中授权 Wrangler，然后创建 Pages 项目。设备授权不依赖浏览器连接本机的 `localhost:8976` 回调服务；命令只申请账户与用户读取、Pages 写入权限：

```sh
npx wrangler login --device --scopes account:read user:read pages:write
npx wrangler pages project create openvoxel-velaros --production-branch=main --force
```

`--force` 只用于首次创建 Direct Upload Pages 项目。后续发布复用已有项目，无需该参数。

随后从仓库根目录发布，后续更新使用同一个命令：

```sh
npm run deploy:pages
```

命令先构建 `@openvoxel/web`，将可上传文件放入 `apps/web/generated/pages-upload/`，
再以 `main` 作为生产分支上传到 `openvoxel-velaros` 项目。上传目录从构建结果生成，
只去除源码映射、编译器内部清单及顶层 `404.html`；浏览器 Worker、WebGPU 编译资源、
纹理与音频继续随站点发布。Pages 在没有顶层 `404.html` 时会把深层路由交给单页应用，
例如 `/worlds/new` 和 `/world/<id>`。`_headers` 由构建清单生成。

本地预览同一份待上传目录：

```sh
npm run build:pages
npm run preview:pages
```

预览地址为 `http://127.0.0.1:7273/`。发布后检查 Pages 返回的实际部署 URL，
确认首页、直接打开 `/worlds/new`、创建本地世界和重新打开存档都正常。
若在自动化环境发布，设置 `CLOUDFLARE_API_TOKEN` 与 `CLOUDFLARE_ACCOUNT_ID`，
然后运行同一个 `npm run deploy:pages` 命令；令牌无需写入仓库。
