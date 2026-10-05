# 演说.io

<https://yanshuo.io>：在线 HTML5 展示文稿（reveal.js）编辑器。

这个仓库是 yanshuo.io 从 **LeanCloud 迁移到 Cloudflare** 之后的部署代码。LeanCloud 将于
**2027-01-12 停止服务**（[公告](https://docs.leancloud.cn/sdk/announcements/sunset-export/)）。

```
public/                    Huxpro/airtalk main 的 dist/ 构建产物（同源 Worker API）
src/index.js               Cloudflare Worker：静态资源 + 兼容 LeanCloud REST 的 /1.1/* API
src/password.js            密码哈希（PBKDF2，兼容校验 LeanCloud 导出的旧哈希）
migrations/                D1 表结构
scripts/export-leancloud.mjs   用 scan API 从 LeanCloud 导出数据（兜底方案）
scripts/import.mjs         把导出数据导入 Cloudflare（D1 + R2）
test/                      迁移端到端测试（npm test）
```

## 现状调研（2026-09-29）

- 站点是纯前端 SPA（React + 打包进来的 LeanCloud JS SDK 0.6.10），由私有仓库 `Huxpro/airtalk`
  的 `gh-pages` 分支通过 GitHub Pages 托管（`CNAME` 为 `yanshuo.io`，只有 2017 年的一次 `dist` 提交，没有源码）。
  域名 DNS 已经在 Cloudflare（`marek/tegan.ns.cloudflare.com`）。
- `Huxpro/ys.static` 是演说里引用的图片等附件，独立托管在 GitHub Pages 上，不依赖 LeanCloud，这次迁移不涉及它。
- 对 LeanCloud 的依赖很少，只有**数据存储**里的两张表，没有云引擎、文件、推送、IM、短信：
  - `_User`：`username` / `email` / `password`，只用了注册和登录。
  - `YSDeck`：`pubUserId`、`metadata`（编辑器工程 JSON）、`metaHTML`（发布后的 HTML）。
    图片（≤4 MB）和视频（≤10 MB）都以 base64 内联在这两个字段里，**单个演说可达几十 MB**。
- 发布链接 `https://yanshuo.io/assets/player/?deck=<objectId>` 由播放器按 id 读取 `YSDeck.metaHTML`。
- **线上其实已经坏了**：LeanCloud 应用处于归档状态（API 返回
  `"The app is archived, please restore in console before use."`），播放器依赖的
  `cdn1.lncld.net` 也已无法访问，所以登录、保存和打开分享链接目前都不能用。

## 为什么选 Cloudflare 而不是 Vercel

| | Cloudflare（Workers + D1 + R2） | Vercel |
|---|---|---|
| 单次请求体上限 | 100 MB（Free/Pro） | **4.5 MB**（Functions 硬限制） |
| 保存几十 MB 的演说 | 直接 PUT，前端不用改 | 要改成客户端直传 Blob，需要改编译后的前端（没有源码） |
| 数据库 / 对象存储 | D1 + R2，原生支持，一个配置文件 | 没有自家数据库，要用 Marketplace 的 Neon/Supabase 加 Vercel Blob |
| DNS | 已经在 Cloudflare，绑定 Custom Domain 即可 | 需要改 DNS 记录指向 Vercel |
| 中国大陆访问 | 能访问（不算快） | `*.vercel.app` 和 Vercel 的 IP 经常被墙或遭 DNS 污染 |
| 费用 | Workers Paid **$5/月**（见下）；D1、R2 在免费额度内，R2 出流量免费 | Hobby 免费但不允许商用，也解决不了请求体上限；Pro $20/月 |

结论是 **Cloudflare**。决定性的一点是请求体大小：yanshuo.io 把媒体内联在演说里，Vercel 的 4.5 MB
上限装不下，要绕开就得重写前端。另外域名已经托管在 Cloudflare，用户主要在国内，这两点也都偏向 Cloudflare。

**需要 Workers Paid 计划（$5/月）**：Free 计划每个请求只有 10 ms CPU。实测 PBKDF2 登录约 60 ms，
校验 LeanCloud 旧哈希约 33 ms，解析一次 15 MB 的保存请求约 20 ms，都会超出这个限制。Paid 计划的
CPU 上限是 30 秒，每月含 1000 万次请求，对这个站点来说绰绰有余。

## 迁移方案

前端源码已恢复到 `Huxpro/airtalk` 的 `main` 分支。使用 Node 22 执行
`npm ci && npm run build`，将生成的 `dist/` 完整复制到本仓库的 `public/`。
当前产物来自提交 `25fbac29f623671b7720b0d45859839b71a24903`。

- 编辑器继续使用 LeanCloud SDK，通过默认的 `VITE_SERVER_URL=/` 同源调用 Worker。
- `public/assets/player/config.js` 的 `serverURL` 同样为 `/`，旧分享链接保持兼容。
- 上面的现状调研记录的是切换前的旧站；本分支提供源码重新构建的前端。
- 存储：`_User` 和 `YSDeck` 的索引放在 D1；`metadata` / `metaHTML` 放在 R2（`decks/<id>/<field>`），
  因为 D1 单行最大 2 MB。
- **保持兼容**：
  - `objectId` 不变，所有旧的分享链接继续可用。
  - `sessionToken` 不变，已经登录的浏览器（localStorage 里的 `AV/<appId>/currentUser`）不需要重新登录。
  - 密码：LeanCloud 控制台导出的 `password` + `salt` 按
    [官方算法](https://docs.leancloud.cn/sdk/start/dashboard/)（`sha512(salt+password)` 再迭代 512 次）校验，
    用户下次登录时自动升级成 PBKDF2-SHA256。
- **顺便修掉的安全问题**：原来任何人拿着前端里公开的 App Key 就能改、删任何人的演说。现在只有作者本人能
  修改或删除自己的演说，列表也只能查自己的；按 id 读取保持公开，分享链接依赖这一点。

## 上线步骤（Runbook）

> 需要 LeanCloud 控制台和 Cloudflare 账号权限，这几步只能由账号所有者来操作。**务必在 2027-01-12 前完成导出。**

### 1. 从 LeanCloud 导出数据

1. 登录 [LeanCloud 控制台](https://console.leancloud.cn)，打开 yanshuo.io 应用
   （App ID `im99VNboLC4mtFOCDlR3q6hT-gzGzoHsz`，华北节点）。应用现在是**归档**状态，先**恢复**它。
2. **数据存储 → 导入导出 → 导出**，选择 JSON，时间范围选全部，导出 `_User` 和 `YSDeck`。
   下载链接会发到账号邮箱，下载后解压到 `export/`（已经加进 `.gitignore`）。
   - `_User` **必须用控制台导出**：只有控制台导出会带 `password` 和 `salt`，REST API 不返回这两个字段。
3. （可选，兜底）`YSDeck` 也可以用 scan API 导出（Master Key 在 设置 → 应用凭证）：
   ```sh
   LC_MASTER_KEY=xxx npm run export:leancloud -- --classes YSDeck --out export/
   ```
   如果应用绑定了自定义 API 域名，加上 `--server https://your-api-domain`。

### 2. 创建 Cloudflare 资源并部署

先在 Cloudflare 控制台 → Workers & Pages → Plans 开通 **Workers Paid**（原因见上）。

```sh
npm install
npx wrangler login
npx wrangler d1 create yanshuo                 # 把输出的 database_id 填进 wrangler.jsonc
npx wrangler r2 bucket create yanshuo-decks
npm run db:migrate                             # 在远端 D1 上建表
npx wrangler secret put ADMIN_TOKEN            # 随机长字符串，只在导入时使用
npm run deploy                                 # 先部署到 yanshuo.<account>.workers.dev
```

### 3. 导入数据

```sh
ADMIN_TOKEN=... npm run import -- --target https://yanshuo.<account>.workers.dev \
  --users export/_User.0.jsonl --decks export/YSDeck.0.jsonl   # 文件名以实际导出的为准，也可以直接传目录
```

脚本支持控制台 JSONL 导出的 `#filetype` 格式头（不计为数据记录）。
脚本可以重复执行（按 objectId upsert），最后会打印服务器上的用户数和演说数，拿来和 LeanCloud 控制台里的
数量核对一下。导入完成后建议删掉这个 secret：`npx wrangler secret delete ADMIN_TOKEN`。

### 4. 验证后切换域名

1. 在 `*.workers.dev` 上验证：用老账号登录、打开几个老的分享链接、新建并发布一个演说。
2. 在 Cloudflare DNS 里删掉 `yanshuo.io` / `www` 指向 GitHub Pages 的记录，然后打开 `wrangler.jsonc`
   里注释掉的 `routes`（Custom Domain），再执行 `npm run deploy`。
3. 在 `Huxpro/airtalk` 里关掉 GitHub Pages（Settings → Pages，或删掉 `CNAME`），避免两边同时提供服务。
4. 可选：Cloudflare → Security → WAF 给 `/1.1/login` 加一条速率限制规则（免费计划有 1 条），防止暴力破解密码。

## 本地开发

```sh
npm install
npm run db:migrate:local
echo 'ADMIN_TOKEN=dev' > .dev.vars
npm run dev          # http://127.0.0.1:8787
npm test             # 迁移端到端测试：导入 → 老密码登录 → 老链接 → 大文件读写 → 权限
```

## API 兼容范围

| 路由 | 用途 |
|---|---|
| `POST /1.1/users` | 注册（错误码 125/202/203 和前端的提示文案一一对应） |
| `GET /1.1/login` | 登录（210/211） |
| `GET /1.1/users/me` | 当前用户 |
| `POST /1.1/classes/YSDeck` | 新建演说（需要登录，`pubUserId` 强制为当前用户） |
| `GET /1.1/classes/YSDeck` | 查询：`where` 支持 `objectId` / `pubUserId` 相等条件，另外支持 `order`、`limit`、`skip`、`keys`、`count` |
| `GET/PUT/DELETE /1.1/classes/YSDeck/:id` | 读取（公开）、更新和删除（仅作者本人） |

SDK 0.6.x 的请求格式是 `POST` + `text/plain` JSON，方法、会话等信息放在 `_method`、`_SessionToken` 字段里；
标准 REST 请求（真实 HTTP 方法 + `X-LC-Session` 头）也同样支持。其他路由统一返回 `119`。

## Isolated staging for airtalk previews

`wrangler.staging.jsonc` deploys `yanshuo-staging.huxpro.workers.dev` with its own
D1 database (`yanshuo-staging`) and R2 bucket (`yanshuo-staging-decks`). It never
binds the migrated `yanshuo` resources. No real users, sessions or password hashes
are copied into staging, and no `ADMIN_TOKEN` is configured. Create test accounts
through the regular signup API/UI.

```sh
npx wrangler d1 migrations apply yanshuo-staging --remote --config wrangler.staging.jsonc
npx wrangler deploy --config wrangler.staging.jsonc
```

The static player is served by this Worker and reads its same-origin staging
API. The airtalk Pages project points its default API and player URLs here.
Production selection in the frontend developer tool explicitly points to the
migrated `yanshuo.huxpro.workers.dev` backend. This configuration does not change
production DNS, GitHub Pages, or the original Worker deployment.
