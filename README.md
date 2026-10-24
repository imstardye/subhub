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
  - 注意：全局上限被恶意刷满时，所有人都会变慢（最多 3s），但正确密码依然可用；
    窗口过后恢复正常速度。
  - 客户端 IP 默认只取 TCP 连接本身（socket），不读 `X-Forwarded-For` 等请求头。
    部署在反向代理后时，请让代理直连传递真实来源（或仅在内网/VPN 暴露后台），
    否则所有请求共用代理 IP，5 次失败会锁住所有人。
  - 若确实需要从代理提供的请求头取 IP，可设置 `SUBHUB_TRUSTED_IP_HEADER`
    （例如 `cf-connecting-ip`）：此时读取该请求头的第一个值并 trim，非法时回退到
    socket。登录限流、订阅导出的访问日志等所有取 IP 的地方统一使用同一规则。
    **安全前提（必须同时满足才能开启）**：源站只放行 Cloudflare 的 IP 段，
    并且 app 端口不暴露在宿主机/公网上（只能经 Cloudflare 访问）。否则任何客户端
    都能自行伪造该请求头，绕过按 IP 的限流。未设置该变量时行为与之前完全一致。

## 环境变量

```bash
SUBHUB_ADMIN_PASSWORD=change-me
SUBHUB_SECRET=change-me-too
SUBHUB_DB_PATH=./.data/subhub.sqlite
# 可选：仅在上面「安全前提」满足时才设置，例如 cf-connecting-ip
# SUBHUB_TRUSTED_IP_HEADER=cf-connecting-ip
```

### 生产部署注意事项

- **必须挂载数据卷并显式设置 `SUBHUB_DB_PATH`** 指向该卷，例如
  `SUBHUB_DB_PATH=/data/subhub.sqlite`。默认值仍是 `.data/subhub.sqlite`
  （相对工作目录），不加改动；容器重建后若不挂卷，用户、订阅源与访问日志会
  随容器一起丢失。
- `SUBHUB_SECRET` 在生产环境必须设置（用于会话签名与订阅源 URL 加密）。

仓库中不会提交任何真实订阅链接、token、密码或私人域名；测试数据一律使用
`example.com` 和假凭据。
