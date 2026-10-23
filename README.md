# subhub

订阅聚合与转换服务（P1 core 阶段）。仓库采用 **AGPL-3.0** 许可。

> 来源声明：`core/parsers`、`core/producers` 的节点解析与输出逻辑移植/改编自
> [Sub-Store](https://github.com/sub-store-org/Sub-Store)（AGPL-3.0）。
> 规则解析参考 subconverter INI 约定，规则输出约定与 Sub-Store 的 Clash
> producer 保持一致。原始项目版权归其贡献者所有，详见 [LICENSE](./LICENSE)。

## 当前阶段（P1）

- Nuxt 3 + TypeScript + pnpm 骨架，core 为纯 TS，不依赖 Nuxt。
- 节点解析：
  - 分享链接：`ss`、`vmess`、`vless`（含 Reality / XTLS flow）、`trojan`、
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

P1 共 46 个单测，覆盖：

- 7 种分享链接解析、Clash YAML、base64 / 纯文本订阅。
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

## 环境变量（后续阶段使用）

```bash
SUBHUB_ADMIN_PASSWORD=change-me
SUBHUB_SECRET=change-me-too
SUBHUB_DB_PATH=./.data/subhub.db
```

仓库中不会提交任何真实订阅链接、token、密码或私人域名；测试数据一律使用
`example.com` 和假凭据。
