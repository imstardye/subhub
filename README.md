# subhub

订阅聚合与转换服务（P1 core 阶段）。仓库采用 **AGPL-3.0** 许可。

> 来源声明：`core/parsers`、`core/producers` 的节点解析与输出逻辑移植/改编自
> [Sub-Store](https://github.com/sub-store-org/Sub-Store)（AGPL-3.0）。
> 规则解析参考 subconverter INI 约定，规则输出约定与 Sub-Store 的 Clash
> producer 保持一致。原始项目版权归其贡献者所有，详见 [LICENSE](./LICENSE)。

## 当前阶段（P1）

- Nuxt 3 + TypeScript + pnpm 骨架，core 为纯 TS，不依赖 Nuxt。
- 节点解析：
  - 分享链接：`ss`、`ssr`、`vmess`、`vless`（含 Reality / XTLS flow）、`trojan`、
    `hysteria2` / `hy2`、`tuic`、`anytls`。
  - Clash / mihomo YAML（完整配置中的 `proxies` 或裸数组）。
  - 纯文本与 base64 订阅，可混合多种协议。
- 节点输出：
  - `mihomo` producer。
  - 老 Clash（`legacy`）producer，自动过滤旧内核不支持的协议与特性。
  - AnyTLS 在 mihomo 输出中默认 `min-idle-session: 0`、
    `idle-session-timeout: 30`。
- 规则：
  - 解析 subconverter 风格 ini 的 `ruleset=` 与 `custom_proxy_group=`。
  - 生成 Clash `rule-providers` / `rules` / `proxy-groups`。
  - 支持传入缓存 resolver 将远端规则集展开为内联规则。
- Vitest 单测覆盖以上能力；所有节点数据均为假的（`example.com`、假 UUID/密码）。

## 技术栈

- [Nuxt 3](https://nuxt.com/) + Vue 3 + TypeScript
- pnpm
- [Vitest](https://vitest.dev/)
- [yaml](https://github.com/eemeli/yaml)

## 目录

```text
core/                 纯 TypeScript，可直接被 Nuxt server 或脚本引用
  parsers/            分享链接 / Clash YAML / base64 订阅解析
  producers/          mihomo 与 legacy Clash 输出
  rules/              subconverter ini 解析、代理组与规则生成
  utils/              base64、URI、类型清理等小工具
  types.ts            公共类型
server/db/            Drizzle schema、SQLite 打开与 URL 加解密
pages/                Nuxt 页面（P1 仅占位）
tests/                Vitest 单测
tests/fixtures/       subconverter ini 测试样本
```

## 开发

```bash
pnpm install
pnpm test        # vitest run
pnpm typecheck   # tsc --noEmit
pnpm dev         # Nuxt 开发服务器
```

## 单测

P1 共 187 个单测，覆盖：

- 8 种分享链接解析、Clash YAML、base64 / 纯文本订阅。
- mihomo / legacy producer 的字段转换、协议过滤与 AnyTLS 默认值。
- 两份 subconverter ini 样本的 ruleset / custom_proxy_group 解析、
  代理组展开、rule-providers 去重、inline 规则与远端规则集展开。

## 测试样本

`tests/fixtures/xr_all_config_v2.ini` 与
`tests/fixtures/xr_all_config_v2_legacy.ini` 取自公开仓库
[jhxxr/script](https://github.com/jhxxr/script) 的 `rule/` 目录。
样本已检查：不含真实订阅链接、token、密码或私人域名；保留下来的 URL
均为公开的 GitHub raw 规则地址。详见
[`tests/fixtures/README.md`](./tests/fixtures/README.md)。

## 数据库（P2 骨架）

`server/db` 使用 Drizzle ORM + better-sqlite3（11.x，兼容当前 Node 20；
13.x 要求 Node ≥ 22）。`SUBHUB_DB_PATH` 缺省为 `.data/subhub.sqlite`，
打开时会创建目录和表。订阅源 URL 经 `server/db/crypto.ts`（AES-256-GCM）
加密后入库，密钥为 `SUBHUB_SECRET`；未设置且非 production 时仅使用开发用
测试密钥，生产环境必须显式配置。

## 管理后台登录（P3 骨架）

- `/login` 提交密码，`POST /api/admin/login` 校验后下发 httpOnly
  `subhub_admin` cookie（HMAC-SHA256 签名，7 天，生产环境 `Secure`）；
  密码错误返回 401 且不写 cookie。
- `GET /api/admin/me` 返回 `{ authenticated }`；全局路由中间件
  `middleware/admin.global.ts` 对所有页面在服务端透传 cookie 查询该接口，未登录
  跳转 `/login?redirect=...`。`/login` 是唯一公开页面，新增页面默认受保护。
- `POST /api/admin/logout` 删除 cookie。
- 生产环境（`NODE_ENV=production`）未配置 `SUBHUB_SECRET` 时拒绝签发会话
  （登录返回 500，已有 token 也无法验证），不会退回公开的开发密钥。

- 登录防爆破：同一 IP 15 分钟内失败 5 次、全局失败 100 次后**只减速、不拒绝**
  （只计失败，成功回退该次计数）。
  - 超过上限后在**校验密码前**先等待一段延迟：首次 1s，同一桶内继续超限则翻倍，
    最长 3s；随后仍正常校验密码，错误依旧返回 401、正确依旧登录成功（不受永久锁死）。
    响应带 `Retry-After` 表示窗口重置时间，不会再出现登录限流 429。
  - 延迟是**串行排队**的，不是让并发请求各自并行睡觉：同一 IP 被减速的请求排队执行，
    后一个在前一个等完之后才开始自己的延迟，因此 N 个并发请求大约要等 N × 延迟；
    全局上限被刷满时，跨 IP 的减速请求也走同一条全局队列。这样并发轰炸无法压缩总耗时，
    密码校验不会被同时触发。
  - 注意：全局上限被恶意刷满时，所有人都会变慢（最多 3s），但正确密码依然可用；
    窗口过后恢复正常速度。
  - 客户端 IP 默认只取 TCP 连接本身（socket），不读 `X-Forwarded-For` 等请求头。
    部署在反向代理后时，请让代理直连传递真实来源（或仅在内网/VPN 暴露后台），
    否则所有请求共用代理 IP，5 次失败后所有人都会一起被减速。
  - 若确实需要从代理提供的请求头取 IP，可设置 `SUBHUB_TRUSTED_IP_HEADER`
    （例如 `cf-connecting-ip`）：此时读取该请求头的第一个值并 trim，非法时回退到
    socket。登录限流、订阅导出的访问日志等所有取 IP 的地方统一使用同一规则。
    **安全前提（必须同时满足才能开启）**：源站只放行 Cloudflare 的 IP 段，
    并且 app 端口不暴露在宿主机/公网上（只能经 Cloudflare 访问）。否则任何客户端
    都能自行伪造该请求头，绕过按 IP 的限流。未设置该变量时行为与之前完全一致。

## 隐藏入口（管理员路径）

站点根路径不再展示任何内容：管理后台只能通过自定义的**入口路径**进入，入口由
环境变量 `SUBHUB_ADMIN_PATH` 配置（默认 `admin`，即 `/admin`）。

- 访问入口 `GET /<路径>`（必须精确匹配，不能带后续路径）会下发 httpOnly
  `subhub_gate` cookie（`SameSite=Lax`、`Path=/`、30 天，生产环境 `Secure`）
  并 **302** 跳转到 `/login`，之后由现有登录流程处理。
- cookie 的值是由 `SUBHUB_SECRET` 签名的 token，**不包含路径**：猜测或伪造
  `subhub_gate=<路径>` 无效。生产环境未配置 `SUBHUB_SECRET` 时入口只返回空白页
  （fail closed），不会退回开发密钥。
- 未携带该 cookie 时，管理后台页面（`/`、`/login`、`/users`、`/sources`、
  `/profiles`、`/logs`、`/preview`）和除登录/登出以外的 `/api/admin/*` 一律返回
  **空白页**（HTTP 200、空 body、`text/html`），**不会**跳转 —— 跳转等于告诉别人
  入口存在。
- 订阅链接 `/s/*` 永不受影响（公开设计，字节级不变）；`/api/admin/login`、
  `/api/admin/logout` 也无需入口 cookie（浏览器刚通过入口跳到 `/login`，登录失败
  后还要能再次提交）。登录本身仍由会话中间件校验。
- 该入口**始终生效**：新浏览器直接打开 `/` 只会看到空白页，直到访问过入口路径。
  这与是否登录无关 —— 换浏览器 / 清 cookie 后都要重新走一次入口。

路径规则：先 trim，去掉首尾 `/`，合并重复 `/`；允许 `hx/panel` 这样的多段路径；
每段必须匹配 `^[a-z0-9][a-z0-9_-]*$`（小写）；首段不能是 `s`、`api`、`_nuxt`
（会与真实路由冲突）。未设置 / 空值 → `admin`；非法值 → 回退 `admin` 并在服务端
日志打印一条警告。

```bash
# Docker
docker run ... -e SUBHUB_ADMIN_PATH=hx/panel ...
# 之后浏览器访问 https://your.example.com/hx/panel 一次，再正常登录
```

## 环境变量

所有可配置项使用 `SUBHUB_*` 前缀。仓库与镜像说明中只放占位符；**切勿**把真实
secret、管理员密码或内网/生产域名写进 Git。

| 变量 | 必填（生产） | 默认 | 说明 |
| --- | --- | --- | --- |
| `SUBHUB_ADMIN_PASSWORD` | 是 | （开发态有固定测试密码；生产未设则拒绝登录） | 管理后台登录密码 |
| `SUBHUB_SECRET` | 是 | （开发态有测试密钥；生产未设则拒绝签发会话） | 会话 HMAC 与订阅源 URL 加密 |
| `SUBHUB_DB_PATH` | 强烈建议显式设置 | `.data/subhub.sqlite` | SQLite 文件路径 |
| `SUBHUB_ADMIN_PATH` | 否 | `admin`（即 `/admin`） | 管理后台隐藏入口路径，如 `hx/panel`；见上文「隐藏入口」 |
| `SUBHUB_TRUSTED_IP_HEADER` | 否 | 未设置（只用 socket IP） | 仅当源站只经可信代理（如 Cloudflare）时再设，例如 `cf-connecting-ip` |

本地开发可参考 [`.env.example`](./.env.example)：

```bash
SUBHUB_ADMIN_PASSWORD=change-me
SUBHUB_SECRET=change-me-too
SUBHUB_DB_PATH=./.data/subhub.sqlite
# 可选：管理后台隐藏入口路径，未设置时为 /admin
# SUBHUB_ADMIN_PATH=hx/panel
# 可选：仅在「可信代理」安全前提满足时才设置
# SUBHUB_TRUSTED_IP_HEADER=cf-connecting-ip
```

## 部署

面向自托管 / 容器部署的通用步骤。镜像由 GitHub Actions（`.github/workflows/release.yml`）
在 `main` 与 `v*` tag 推送到 GHCR；PR 只跑测试与构建校验，不推送镜像。

### 镜像（GHCR）

```bash
# 最新 main
docker pull ghcr.io/imstardye/subhub:latest

# 或固定到某次提交短 SHA / 版本 tag（推荐生产）
docker pull ghcr.io/imstardye/subhub:sha-<short-sha>
docker pull ghcr.io/imstardye/subhub:v0.1.0   # 仅当已打对应 tag
```

包为 public 时可直接 pull；若将来改为 private，需先
`docker login ghcr.io`（用有 `read:packages` 权限的 token）。

镜像默认监听 `0.0.0.0:3000`（`PORT` / `NITRO_PORT`），工作目录 `/app`，
并以非 root 的 `node` 用户运行；Dockerfile 声明了 `VOLUME /data`。

### 数据卷与数据库路径

- **开发默认**：未设 `SUBHUB_DB_PATH` 时仍为 `.data/subhub.sqlite`（相对进程工作目录）。
- **生产必须**：
  1. 把宿主机（或命名卷）挂到容器内持久目录，推荐挂载点 `/data`；
  2. **显式设置** `SUBHUB_DB_PATH` 指向该卷上的文件，例如
     `SUBHUB_DB_PATH=/data/subhub.sqlite`。

不挂卷或不设路径时，容器重建会丢掉用户、订阅源与访问日志。

### 反向代理（不要直接暴露应用端口）

应用容器应只在内网 / Docker 网络可达；**不要把 3000 直接映射到公网宿主机**。
前面用 [Caddy](https://caddyserver.com/)（或 Nginx、Traefik 等）做 TLS 与反代。

Caddy 示意（把 `app:3000` 换成你的容器服务名与端口；`your.example.com` 换成你的域名）：

```caddy
your.example.com {
  reverse_proxy app:3000
}
```

若源站只经 Cloudflare 回源，且应用端口不对公网开放，才可设置：

```bash
SUBHUB_TRUSTED_IP_HEADER=cf-connecting-ip
```

**风险**：对该请求头不可信时（例如任何人能直连应用端口并伪造头），按 IP 的登录减速
与访问日志会被绕过或污染。未设置时始终只用 TCP socket 对端 IP（与代码默认一致）。
更多说明见上文「管理后台登录」。

### 环境变量与首次管理员密码

生产至少设置：

```bash
SUBHUB_ADMIN_PASSWORD=<强随机密码>
SUBHUB_SECRET=<强随机密钥>
SUBHUB_DB_PATH=/data/subhub.sqlite
```

- 首次启动后先访问隐藏入口（默认 `https://<域名>/admin`，或
  `SUBHUB_ADMIN_PATH` 配置的路径），再在 `/login` 用 `SUBHUB_ADMIN_PASSWORD` 登录。
  直接打开 `/` 只会看到空白页。
- 密码存在环境变量里（当前无独立「设密」接口）；改密 = 改环境变量并重启容器。
  轮换 `SUBHUB_SECRET` 会使已有会话全部失效（需重新登录），并影响已加密入库的
  订阅源 URL（轮换前请确认有备份与迁移计划）。
- 生产未配置 `SUBHUB_ADMIN_PASSWORD` / `SUBHUB_SECRET` 时会 fail closed（无法登录 /
  无法签发会话），不会回退到开发用固定值。

登录防爆破行为与上文一致：超限后**减速**（最长约 3s、串行排队），**不是** 429 永久锁死；
正确密码在减速后仍可登录成功。

### 示例：`docker run`

```bash
docker run -d --name subhub --restart unless-stopped \
  -e NODE_ENV=production \
  -e SUBHUB_ADMIN_PASSWORD=change-me \
  -e SUBHUB_SECRET=change-me-too \
  -e SUBHUB_DB_PATH=/data/subhub.sqlite \
  -e SUBHUB_ADMIN_PATH=change-me-path \
  -v subhub-data:/data \
  --network <internal-or-proxy-network> \
  ghcr.io/imstardye/subhub:latest
```

将 `change-me` / `change-me-too` / `change-me-path` 换成真实密钥与入口路径
（只放在宿主机环境或密钥管理里，
不要提交进仓库）。通过反代网络访问容器，而不是 `-p 3000:3000` 暴露到公网。

### 健康检查

当前仓库**没有**单独的 `/health` 接口。探活可用：

- TCP：确认容器内 `3000` 在听；
- HTTP：请求 `GET /`，任何情况都应返回 `200`（带入口 cookie 的正常页面，
  或不带 cookie 的空白页）—— 注意它无法区分「应用健康」与「被门禁拦住」；
  `GET /login` 不带入口 cookie 时也是空白 `200`，同样不再是有效探活。

说明：`GET /api/admin/me` 受管理 API 中间件保护，未带有效会话时返回 **401**，
不适合作为匿名探活。编排层（Docker / Compose / K8s）可把 TCP 或 `/login`
配成 `healthcheck` / liveness probe。

### 自建镜像（可选）

若不用 GHCR，可在含 `Dockerfile` 的仓库根目录构建：

```bash
docker build -t subhub:local .
```

仓库中不会提交任何真实订阅链接、token、密码或私人域名；测试数据一律使用
`example.com` 和假凭据。
