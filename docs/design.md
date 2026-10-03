# DSH 个人工作台插件 — 设计构思（v0.1 草案）

> 目标：一个装在 DSH profile 里的「个人信息工作台」插件：多源聚合 → 归一化 → 去重排序 → 在 Web UI 里看 → 也能喂给 Agent 写早报。
> 这份文档只做设计；所有 Harness 侧的接口事实都已用 `cordis_inspect_query` 核对，外部信息源的行为都用本机实测过（见 §3）。

---

## 1. 一句话架构

**一个 bundle，多个可单独开关的插件行（一行 = 一个包）；核心是「源注册表 + 统一出网层 + 域存储」，每个信息源是一个独立贡献者，UI 是同一包的 Client 半。**

```
                    ┌───────────────────────── DSH Web UI ─────────────────────────┐
                    │  main(key=workbench) 中央工作台页                              │
                    │  sidebar.panellist   侧栏图标                                  │
                    │  settings.section    工作台设置页                              │
                    └───────────────▲──────────────────────────┬───────────────────┘
                        HTTP/SSE    │                          │ fetch
                        /workbench/*│                          │
   ┌────────────────────────────────┴──────────────────────────▼───────────────────┐
   │  dsh-my-homepage  —— Host 半                                              │
   │   ctx.workbench  ── 源注册表 · 抓取引擎 · 归一化/去重 · 评分 · 已读 · 检索        │
   │   ctx.storageDomain 域 `workbench`（items / sources / read / meta）              │
   │   ctx.webServer      → /workbench/items|sources|refresh|state|events(SSE)       │
   │   ctx.tools.register → workbench_brief / search / refresh / read / sources      │
   │   ctx.schedule       → 每日早报投递进会话                                        │
   │   event `workbench/changed`  → 驱动 UI 与其它插件                                │
   └───────▲────────────┬───────────────┬──────────────┬─────────────┬──────────────┘
           │            │               │              │             │
   source-aihot   source-rss     source-youtube  source-hf-papers  source-bilibili ...
   （P1 起各自独立成包 ⇒ 各自一行、独立 enable/disable、独立 Config、独立失败域）
```

关键取舍：**核心不认识任何具体网站**。它只认 `WorkbenchSourceProvider` 接口；加一个源 = 加一个包 + 一行 patch，不动核心、不动 UI。

---

## 2. 模块划分

**一个硬约束先写在前面**：`dsh-client-modules` 的 README 明确写着 *「Distinct active Loader sources resolving to one package name are rejected」*——**同一个包名不能有两个同时生效的插件行**。所以「一个包目录里塞多行、每行指向包内不同文件」这条路走不通：那些行都会解析到同一个包名，直接冲突。

于是模块化的落法是：**一个模块 = 一个包 = 一个插件行**。每个包就是一个 `package.json` + 一个 JS 文件，所以拆包的成本其实很低。

| 行 id（= 包名） | 职责 | 阶段 |
|---|---|---|
| `dsh-my-homepage` | **唯一的包**：Host 半 = `ctx.workbench` 服务（源注册表、抓取调度、归一化、去重、评分、域存储）+ `/workbench/*` 路由 + Agent 工具；Client 半 = 主面板页、侧栏图标、设置页 | **P0** |
| `dsh-my-homepage-source-aihot` | AIHOT JSON API 同步（`snapshot` + `changes`） | 从 P0 的内置源拆出（P1） |
| `dsh-my-homepage-source-rss` | **通用源**：给任意 RSS/Atom 地址就能加源（纯配置驱动，不写代码） | P1 |
| `dsh-my-homepage-source-youtube` | 频道 handle → channel_id → Atom feed | P1 |
| `dsh-my-homepage-source-hf-papers` | HuggingFace 每日论文 API | P1 |
| `dsh-my-homepage-source-producthunt` | Product Hunt Atom feed | P1 |
| `dsh-my-homepage-source-bilibili` | UP 主投稿变更通知（见 §6.6 降级方案） | P3 |
| `dsh-my-homepage-fetch-firecrawl` | 可选：注册「出网后端」供兜底阶梯用 | P3 |
| `dsh-my-homepage-tools` | （可选）把 Agent 工具拆出来单独开关 | 按需 |

每个源独立成包 ⇒ 在 Plugins 页面**逐行开关**，一个源炸了不影响别人，也不会让 core 启动失败。

**但 P0 不要一开始就拆包。** 一个包可以同时有 Host 半和 Client 半（decoration 模板就是这个形状），所以 P0 = **一个包 `dsh-my-homepage`**：host 半放 core + aihot 源 + 路由 + 工具，client 半放 UI，一行、一次安装，最快打通端到端。到 P1 再把每个源提升成独立包（`dsh-my-homepage-source-*`，各自 host-only、各自一行），那时才真正拿到「逐源开关」的收益。

理由是：P0 的真正未知数是「HTTP 前缀路由能不能通」和「域存储能不能写」。先用最小结构把这两件事验证掉，之后摊开包结构几乎没有返工成本（源模块本来就是接口隔离的，搬文件而已）。

`dsh-my-homepage-source-rss` 仍是杠杆最大的一块：Product Hunt、绝大多数博客/播客、很多站点的 `/feed` 都能靠它覆盖，值得优先于所有专用源实现（§6.1 有 18 个现成种子源）。

---

## 3. 实测结论（先于设计，全部在本机跑过）

这些不是推测，是刚才真实请求的结果，直接决定了技术选型。

### 3.1 AIHOT：有完整公开 API，是本工作台最值钱的单一信息源

`https://aihot.news/api/v1/items` 是匿名只读 JSON API，**无需 API Key**，并且官方维护了一份 OpenAPI 3.1 规范：`https://aihot.news/openapi-v1.json`（标题 *AIHOT Public API v2.0.0*，177 KB）。

可用端点（节选，全部 GET）：

| 端点 | 用途 |
|---|---|
| `/api/v1/items` | 滚动窗口条目；参数 `mode=selected\|all`、`category=ai-models\|ai-products\|industry\|paper\|tip`、`window=24h\|7d`、`by=timeline\|published`、`q=`（2–200 字）、`limit=1..100`、`cursor=` |
| `/api/v1/hot-topics` | 当前多源热点 Top 10（含 `sourceCount`/`signalCount`/`participantCount`/`sourceNames`） |
| `/api/v1/stories/{publicId}` | 一个事件的来龙去脉 + AI 摘要 |
| `/api/v1/dailies/latest`、`/weeklies/latest`、`/monthlies/latest` | 日报（每天 08:00 Asia/Shanghai 出）/周报/月报，历史期次可定点取 |
| `/api/v1/selected/snapshot` + `/api/v1/selected/changes` | **官方推荐的本地镜像方式**：快照一次，之后只拉增量 |
| `/api/v1/agent/*` | 面向 Agent 的**中文 Markdown** 成稿面（`latest`/`search`/`hot`/`daily`/`weekly`/`monthly`/`stories`） |
| `/feed.xml` | 现成 RSS（实测 200，50 KB） |

条目字段（`Item` schema，官方文档里是 `required`）：

```
id, title, originalTitle, summary, source.name,
links.aihot, links.original, publishedAt, discoveredAt,
category, score(0–100), selected(bool), reason(推荐理由), attribution
```

官方在规范里写明的使用要求，设计必须照做：

- 轮询间隔 **不得快于响应头 `Cache-Control: s-maxage`**（`/items` 与 `/hot-topics` 当前都是 60s）；务必带 `If-None-Match`，未变返回 304 空 body。
- 压缩：`Accept-Encoding: gzip`（JSON 能缩到 1/4–1/8）。
- 增量：翻页翻到「已有 id」就停；要完整镜像用 `snapshot` + `changes`。
- 单 IP 约 60 req/min 以上返回 429，按 `Retry-After` 等待，**不要并发重试**。
- 无推送通道（无 SSE/webhook），官方明确要求「轮询，不要长连接」。
- User-Agent：程序化同步用 `aihot-api/2.0.0`。
- **许可**：个人非商业、公益非商业、组织内部使用免费；对外商业产品/代理/转售/公开镜像/批量再分发需书面授权，且**仅署名不等于授权**（`https://aihot.news/terms`）。个人工作台属于免费范围，但 UI 上应保留 `attribution` 与 canonical 链接。

> 结论：AIHOT 模块要**两个面**——给 UI 用 JSON（`selected/snapshot` + `changes`），给模型用 Markdown（`/agent/*`）。它自带的 `score` + `reason` 是现成的相关性信号，不用我们重复造。

### 3.2 YouTube：频道 RSS 可用，handle 可解析

- `https://www.youtube.com/feeds/videos.xml?channel_id=UCXl4i9dYBrFOabk0xGmbkRA` → 200，21 KB Atom，标题正是 **Dwarkesh Patel**（即 `@DwarkeshPatel`）。
- handle → channel_id：请求频道页 HTML（实测 200，1.7 MB）后正则抓 `channelId`（或 `"externalId"`）。**一次性解析后写进配置**，别每次轮询都抓页面。
- 描述/字幕：元数据里有标题、发布时间、`media:description`；**逐字稿不在此 feed 内**，需要单独方案（属于 P3）。

### 3.3 HuggingFace 论文：原生 JSON API

`https://huggingface.co/api/daily_papers?limit=1` → 200，JSON，字段形如 `paper.{id, authors[], ...}`。比抓 HTML 页面（`/papers/date/...`）稳得多。

### 3.4 Product Hunt：有官方 Atom feed，不需要 token

`https://www.producthunt.com/feed` → 200，43 KB Atom（还支持 `?category=artificial+intelligence`）。
GraphQL v2 需要开发者 token 且 Cloudflare 较严；**个人工作台用 feed 就够了**，先不碰 token。

### 3.5 Bilibili：官方 API 反爬明确，属于「难源」

实测：
- `api.bilibili.com/x/space/wbi/arc/search?mid=...` → **412**（WBI 签名风控）
- `api.bilibili.com/x/space/arc/search?mid=...` → 200 但 body `{"code":-799,"message":"请求过于频繁，请稍后再试"}`

也就是说：无 cookie 无签名直接打接口**不通**。B 站必须单独设计（§6.3），不能按「普通源」估工时。

### 3.6 Harness 侧接口已核对事实（决定了插件怎么写）

| 事实 | 出处 | 对设计的后果 |
|---|---|---|
| `main` 是 **keyed** 槽位，注册参数只有 `key`；已占用 `plugins`、`conversation`；catalog 说明「保留 key `conversation` 承载对话，其它 key 不绑定 Session」 | `Slots.listSubTree` root=`main` | 工作台主页注册 `{ key: 'workbench' }`，天然不绑 Session |
| `sidebar.panellist` 的 catalog 原文：**「Each list id addresses the matching main panel; the sidebar owns the button and resolves its label from list metadata.」**；图标组件收到 `{ size, active }` | `Slots.listSubTree` root=`sidebar.panellist` | **只需注册一个 `{id:'workbench', label:'工作台'}`**，侧栏按钮与主面板切换自动接好，不用手写导航 |
| `ctx.layout.selectPanel(panelId)`「选择全局中央面板，不改变当前 Session」，未注册的 key 会抛错 | client `Service layout` | 需要从别处（如「打开工作台」命令/工具）跳转时用它；正常情况下用不上 |
| 主面板/侧栏组件的 standardProps 含 `useResource`、`usePanelInfo`、`useSessions`、`useSessionStatus`、`useWorkspaces` | 同上 | 数据获取用 `useResource`，不用自己造 store |
| `ctx.tools.register(definition)` → `execute(args, exec: ToolRunContext)`，`ToolRunContext extends ToolExecution`，带 `agent?: Agent`(= `{id: SessionId}`) 与 `signal` | host `Service tools` | **工具里能拿到发起会话 id**，所以「订阅每日早报」可以直接把 schedule 绑到当前会话，不需要用户填 id |
| `ctx.schedule.create(sessionId, {daily:{time,time_zone} / cron / every_seconds / after_seconds / at, title, prompt})`；投递就是往绑定会话塞一条 prompt | host `Service schedule` | 早报不用在插件里调模型：建一个 daily 任务，prompt 里让模型调 `workbench_brief` 写早报 |
| `ctx.storageDomain.open(defineDomain(...))` → `domain.table(name)`：`get/entries/keys/put/delete/update` + `domain.global` | host `Service storageDomain` | 持久化方案（§4.3） |
| `host.call(method,args)` 这个内置 RPC **只属于「动态 Cordis 包」**（`cordis_define`/`cordis_run` 那条路，且刷新后不恢复、渲染在 `tool.view.cordis` 卡片里） | client `Builtin` + `dsh-cordis-client-runner` README | 常驻工作台**不能**靠它；Host↔Client 通道按 §7.1 自建（HTTP 路由） |

### 3.7 重要 Harness 侧约束：**不能用 `ctx.web.fetch` 抓这些站**

本机所有目标域名都被代理的 fake-IP DNS 解析到 `198.18.x.x`（`aihot.news→198.18.0.96`，`youtube→198.18.0.105`，`huggingface.co→198.18.0.106`，`producthunt→198.18.0.107`，`bilibili→198.18.0.108/109`），而 Harness 的 `web` 服务内置「非公网 IP」拦截：

```
web_fetch("https://aihot.news/api/items?window=7d")
→ Error: URL hostname "aihot.news" resolves to a non-public IP address
```

但**同一个 URL 用 Node 的全局 `fetch` 完全正常**（实测 aihot 200 / YouTube feed 200 / HF API 200）。原因是这是 TUN 模式的透明代理，TCP 本身通，被拦的只是 Harness 的那层地址校验。

> **设计后果**：workbench-core 必须自带出网层（Node 18+ 全局 `fetch` / undici），不能用 `ctx.web.fetch`。这也顺带解放了「自定义 UA / ETag / 限速 / 代理」这些本来就需要的能力。
> 另外这也意味着：`web` 服务里注册 WebFetchProvider 那条路（把 Firecrawl 变成全局 `web_fetch` 后端）会**同时**受这个 IP 校验影响，只能作为核心自建出网层的可选后端，不能替代它。

---

## 4. 数据模型与存储

### 4.1 归一化条目

```ts
interface WorkbenchItem {
  id: string              // `${sourceId}:${nativeId}`，稳定、幂等
  sourceId: string
  sourceLabel: string
  category: 'ai-models'|'ai-products'|'industry'|'paper'|'tip'|'video'|'podcast'|'product'|'repo'|'other'
  title: string
  url: string             // 原始链接
  canonicalUrl: string    // 去 utm_*、去尾斜杠、统一 host
  author?: string
  publishedAt?: string
  fetchedAt: string
  summary?: string
  reason?: string         // AIHOT 的「推荐理由」，有就透传
  score?: number          // 源侧分数（AIHOT 0–100）
  metrics?: Record<string, number>
  tags?: string[]
  lang?: string
  clusterId?: string      // 跨源去重簇
  contentRef?: string     // 正文/字幕的懒加载缓存引用
}
```

### 4.2 去重（跨源）

AIHOT 本身已经聚合了很多源，你再单独订阅 HF/YouTube/PH，**同一条内容必然重复**。三档：

1. `canonicalUrl` 完全相同 → 直接合并。
2. 标题指纹（小写、去标点、去停用词、按 shingle/SimHash）相似度 > 阈值 → 合并成簇。
3. 同簇只在列表里出现一次，行内标「另有 N 个来源」，点开看该簇全部链接与各源摘要。

簇用并查集在入库时增量维护，`clusterId` 存进条目，避免每次查询重算。

### 4.3 存储：Harness 域存储为主

Harness 提供的就是**持久 KV 域**（`ctx.storageDomain.open(defineDomain({...}))` → `table(name)` 有 `get/entries/put/delete/update`），带 schema 校验与重启加载。用 `ctx.storageDomain` 而不是自己写文件，好处是：不用管路径与沙箱、天然按插件生命周期卸载、写入有二次校验。

域 `workbench`，`version: 1`（改字段语义就升版）：

| 表 | key | value | 说明 |
|---|---|---|---|
| `items` | item.id | WorkbenchItem | 条目本体 |
| `sources` | sourceId | `{etag,lastModified,cursor,lastOkAt,lastError,failStreak}` | 增量与退避状态 |
| `read` | item.id | `{seen,starred,hidden,openedAt}` | **与条目分开**，否则每次轮询都要重写全部条目 |
| `meta` | global | `{schemaVersion,lastDigestAt}` | 单例 |

保留策略：每源上限 2000 条 / 30 天；`starred` 永不清理。正文（`contentRef`）懒加载、单独限额。

> 可选加一层：把每日摘要导出成工作区里的 Markdown（`workbench/2026-10-03.md`），这样它能被 grep、被 git、也能被 Agent 的 read 工具直接读。**建议 P2 再加**，不要一开始就双写。

---

## 5. 抓取层（core 里的统一出网）

一个 `WorkbenchFetcher`，所有源共用，源自己只描述「要什么」，不关心「怎么礼貌地要」：

- 每 host 令牌桶 + 全局并发上限（3）；请求间最小间隔（小站 1–2s）；**带抖动的**指数退避（不带抖动的话几十个源会同步成惊群）。
- 条件请求：存 `ETag` / `Last-Modified`，带 `If-None-Match` / `If-Modified-Since`，304 直接算成功（零流量、不重新解析）。**这是 feed 轮询最大的省钱点**。
  ⚠️ Node 原生 `fetch`/undici **不带 HTTP 缓存**，验证器得自己存（正好落在 `sources` 表的 `etag`/`lastModified` 字段）。想省事可以换成 `make-fetch-happen`（npm 自家那套缓存 fetch）。
- 区分失败语义：**403 = 反爬**（狠狠退避，别紧着重试）、**429 = 限流**（尊重 `Retry-After`）、**503 = 过载/挑战**。
- `robots.txt`（RFC 9309）合规与「礼貌」是**两件事**：RFC 只规定 Allow/Disallow，**没有速率语义**，`crawl-delay` 是非标准字段（Google 明确不支持）。所以：解析 robots（可用 `robots-parser`，46 KB）+ 自己控速。UA 用带说明和联系方式的自定义串（AIHOT 程序化同步用 `aihot-api/2.0.0`）。
- 每个请求都挂 `AbortSignal.timeout()`——任何请求都不许挂住轮询循环。
- **不要用 `setInterval` 排轮询**：它会漂移，且上一次跑长了会重叠。用自重排的 `setTimeout` 或每源带锁的队列。
- 解析完就丢响应体，别把每个 HTML 字符串留在内存里——长跑轮询器的内存都是这么涨上去的。
- gzip/br；可选 `proxyUrl`：本机跑着一个本地代理（`127.0.0.1:7897`）且 DNS 是 fake-IP 模式。实测 Node 全局 `fetch` 直连这些域名就已经通了（TUN 透明代理），所以 `proxyUrl` 默认留空；但它必须是**可配置项**，因为换网络环境后直连不一定通。配置里同时留 `noProxy` 白名单。
- 响应体大小上限 + 超时；失败只污染该源，`failStreak` 到阈值就降频并上报状态，**不影响其它源**。

**兜底阶梯**（只在原生方式失败时逐级下降，每级都可配置关闭）：

| 档 | 手段 | 成本 | 何时用 |
|---|---|---|---|
| 0 | **原生 API / RSS**（首选） | $0 | 永远先用这个。你关心的 4 个源里 3 个都在这档 |
| 1 | **HTML → 正文抽取**：undici fetch → `@mozilla/readability` + `linkedom`（910 KB，比 jsdom 的 7.1 MB 轻得多；遇到 linkedom 没实现的 API 再局部换 jsdom） | $0，约 20 行 | 有 RSS 但没有正文，或普通服务端渲染的文章页 |
| — | ~~`ctx.web.fetch`~~ | ❌ | 不可用（§3.7，实测被 IP 校验拦） |
| 2 | **Jina Reader**：`https://r.jina.ai/<URL>`，**无 key 也能用**，实测 20 req/60s/IP，直接返回干净 markdown | $0（免费档） | 零配置救几个顽固页面。注意 Jina 已被 Elastic 收购，长期免费档有不确定性 |
| 3 | **Firecrawl 云**：`POST https://api.firecrawl.dev/v2/scrape`，`Authorization: Bearer fc-...`，返回 `data.markdown/html/json` | **免费档 1000 credits/月**（≈1000 页），Hobby $19/月 = 5000 | 真正难啃的那一小撮：强反爬、JS 壳、PDF、要结构化 JSON。**免费额度通常就够这个尾巴** |
| 4 | **交给 Agent**：条目标记 `needsAgent: true`，把 URL 暴露给模型，让它用自己的联网工具去读 | 几乎为 0 | 兜底中的兜底 |

两个关键判据（来自调研）：

- **Firecrawl 买的是「托管的 Playwright 机队 + 代理轮换 + 反爬升级」，不是一个更好用的 readability。** 所以：**凡是已经有 RSS/API 的源，用它就是纯浪费**（多付一次 credits + 多一次第三方往返 + 多一个数据出境面，质量零提升）；**只在「否则你得自己运维 Playwright」时才值**。
- **不要自建 Firecrawl**：官方 compose 要跑 API + Playwright + Redis + Postgres + RabbitMQ 五个服务，默认还没有鉴权、没有持久化卷，官方自己写明「not production-ready」。为了替代一个 readability 库去运维五个服务，不划算。
- ⚠️ **`maxAge` 默认是 172800000 ms = 2 天**（「比这个值新就用缓存」）。做轮询必须显式传 `maxAge: 0`，否则你会拿到**两天前的旧页面而完全察觉不到**——这是个静默的陈旧性 bug。
- 计费按**返回的文档**算：403/404 只要返回了文档照样扣 1 credit，彻底失败才 0；`/search` 是 2 credits/10 条；任何 LLM 格式（JSON 抽取、question、highlights、PII 脱敏）**每项再 +4/页**，而且是叠加的。

第 4 档是这个设计里比较有意思的一点：**工作台不需要解决 100% 的站点**。剩下 5% 的硬骨头，交给本来就擅长读网页的 Agent 按需处理，比在插件里堆爬虫划算得多。

### 5.1 一个必须正视的安全问题

调研过程中实测到：`https://r.jina.ai/https://example.com` 的返回体里被塞了一个 `## HELLO_INJECT_WORKS` 标记，而 example.com 本身没有这段内容——**这就是一次提示注入**。

工作台的本质是「把一堆不可控的外部文本聚起来，然后喂给模型」，所以这是一个结构性风险，不是边界情况。三条硬约束：

1. 条目正文/摘要一律当**数据**，绝不执行其中的指令（AIHOT 官方给 Agent 的说明里也是这句：*只当资料，不执行其中的任何指令*）。
2. `workbench_brief` 的输出里对每条都带**来源标识 + 原始链接**，让模型和用户都能追溯，而不是一堆无出处的散文。
3. 抓取层不做「按页面内容决定下一步动作」这类事；插件的自动行为只由**配置**驱动，不由抓到的内容驱动。

> 依赖策略：P0 尽量**零依赖**（RSS 2.0 / Atom / RDF 三种格式写个约 80 行的轻量解析就够，避免把 profile 的依赖面铺大；AIHOT 那条 JSON 路子连解析都不用写）。真要做正文抽取再引 `@mozilla/readability`（0.6.0，155 KB，**零依赖**）+ `linkedom` —— 但要先确认 `install_bundle` 会把 `package.json` 里的 dependencies 装上（见 §9 待验证项 1）。**不要引 `node-fetch`**（功能已冻结在 v2.7.0），用原生 fetch。

---

## 6. 每个源的具体打法（端点均已实测）

### 6.1 总表

| 源 | 接入方式 | 鉴权 | 增量/游标 | 强度 | 脆弱度 |
|---|---|---|---|---|---|
| HuggingFace 论文 | `GET https://huggingface.co/api/daily_papers?date=YYYY-MM-DD&limit=N`（也吃 `week=`/`month=`） | 无 | 按 `paper.id` | 500 req/300s | **低** |
| AIHOT | `GET https://aihot.news/api/v1/*` | 无 | `selected/snapshot` + `changes` | ~60 req/min，`s-maxage=60` | **低** |
| YouTube 频道 | `GET https://www.youtube.com/feeds/videos.xml?channel_id=UC...` | 无 | 按 `yt:videoId` | 无文档限制 | **低**（feed）/ 高（字幕） |
| Product Hunt | `GET https://www.producthunt.com/feed`（Atom） | 无 | 按 entry id | HTTP 层 | **中**（Cloudflare 前置，但不拦） |
| 任意 RSS | 直接用 | 无 | 按 guid/link | 各自 | 视站点 |
| Bilibili 投稿 | 自建 RSSHub `/bilibili/user/video/:uid` | 建议带 cookie | `bvid` | 强风控 | **高** |

各自 `Config`：`enabled`、`cadenceMinutes`、源特有字段（如 YouTube 的 `channels: [{handle, channelId?, label}]`）。

**种子源清单**：AIHOT 那个仓库里 `industry/sources.json` 有 18 个公开信源（OpenAI News、DeepMind、Google Research、HF Blog、Microsoft Research、NVIDIA、AWS ML、GitHub Blog AI&ML、Mistral、BAIR、The Verge AI、TechCrunch AI、Ars Technica AI、MIT Tech Review AI、The Decoder、Simon Willison、Import AI、Latent Space），全部是 `kind: "rss"`。**直接抄成 `source-rss` 的默认配置**，第一天就有 18 个源上线，零额外代码。

### 6.2 AIHOT

三个面，各取所需：

- **UI 面**（结构化、可点、可筛）：`/api/v1/selected/snapshot` 拉一次全量镜像 → 之后只打 `/api/v1/selected/changes`（官方指定的精确镜像法）。
- **RSS 面**（想零代码）：`/feed.xml`（精选 50）、`/feed/full.xml`、`/feed/all.xml`（7 天全量）、`/feed/daily.xml`、`/feed/weekly.xml`、`/feed/monthly.xml`、`/feed/category/{paper,ai-models,ai-products,industry,tip}.xml`。
- **模型面**（中文成稿，省 token）：`/api/v1/agent/latest?window=7d&category=paper`、`/agent/search?q=`、`/agent/hot`、`/agent/daily`、`/agent/weekly`、`/agent/monthly`、`/agent/stories/{id}`。

另有两个值得注意的现成资产：

- **官方 MCP**：`https://aihot.news/api/mcp`（Streamable HTTP，8 个只读工具）。DSH 本身支持 MCP 接入，所以除了自己写模块，还可以**把 AIHOT 作为 MCP 连接**接进来让 Agent 直接用——成本更低，但只给模型用、没有工作台 UI。两者可以并存。
- `https://aihot.news/llms.txt`。

**必须照做的礼貌策略**：`If-None-Match`（304 零流量）+ gzip/br + 轮询不快于 60s + 翻页翻到已知 id 就停 + 429 按 `Retry-After` 等待且不并发重试。UA 程序化同步用 `aihot-api/2.0.0`（非强制）。
**注意**：旧的 `/api/public/*` 将于 **2026-10-31** 下线，别写成那个。

`hot-topics` 返回 `rank/sourceCount/signalCount/participantCount/sourceNames/latestAt`（**没有热度数值**），排序就是 rank。日报结构是 `report.sections[{label, items[]}]`，天然适合直接渲染成早报。

### 6.3 YouTube

- **handle → channel_id 的正确抓法**：抓 `https://www.youtube.com/@<handle>`，按可信度取 `<link rel="canonical" href=".../channel/UC...">`，其次 `<meta property="og:url">`。
  ⚠️ **别抓页面上第一个 `channelId`**：`@DwarkeshPatel` 页面上同时有 `UCXl4i9dYBrFOabk0xGmbkRA`（Dwarkesh Patel，正确）和 `UCZa18YV7qayTh-MRIrBhDpA`（"Dwarkesh Clips" 关联频道，错误）。解析结果**写进配置缓存**，不要每次轮询都抓 1.2 MB 的页面。
  `oembed` 接口对 handle 已返回 Not Found，别用。
- **feed 只给最近 15 条**，无分页；要回填历史只能用 Data API 或 yt-dlp。
- **`media:description` 通常是空的**（实测 15 条里只有 2 条非空）。想要描述/时长/播放量要再抓一次 watch 页 `shortDescription` / `lengthSeconds` / `viewCount`。
- **字幕不要自己做**：`timedtext` 的 `baseUrl` 现在带 IP 绑定 + 过期签名 + PO token 要求，实测 `&fmt=json3` 返回 200 但 **0 字节**。真需要逐字稿就走 `yt-dlp --skip-download --write-auto-subs`（P3，按需）。

### 6.4 HuggingFace 论文

`GET /api/daily_papers?date=YYYY-MM-DD`（`date=` 会按 `submittedOnDailyAt` 过滤，实测生效）。省略 `date` 得到最近一批。
字段：`paper.{id(arXiv id), authors[], title, summary(全文摘要), upvotes, githubRepo, githubStars, projectPage, organization}` + 条目级 `numComments / thumbnail / submittedBy / isAuthorParticipating`。
规则链接：`https://huggingface.co/papers/<id>`、`.pdf`；缩略图 `https://cdn-thumbnails.huggingface.co/social-thumbnails/papers/<id>.png`。
⚠️ **HF 论文没有 RSS**（`/papers/feed.xml` → 401），**HTML 页面里也没有内嵌 JSON**（1.16 MB SvelteKit，grep 不到 `daily_papers`），所以只能用这个 API，不要 scrape。
匿名限额实测 `500 req / 300 s`。

### 6.5 Product Hunt

- **主用 Atom feed**：`https://www.producthunt.com/feed`（可加 `?category=artificial+intelligence`）。entry 给到 post id、slug、product name、tagline(html)、published、maker handle。**没有票数**。
- 想要票数/详情：解析首页里的 `ApolloSSRDataTransport` JSON（`homefeed.edges.find(e => e.node.id === 'FEATURED-0').node.items`），字段 `name/tagline/slug/createdAt/thumbnailImageUuid/product.slug/topics`。（RSSHub 的 `/producthunt/today` 就是这个路子。）
- **不要围绕官方 GraphQL v2 做设计**：需要 application token，而开发者创建页现在**未登录不可达**（多个候选路径 302 回首页），无法确认能拿到 token。限额是 6250 complexity / 15 min。
- `www.producthunt.com` 在 Cloudflare 后面（`Server: cloudflare`），当前不拦；`api.producthunt.com` 是另一套源站。

### 6.6 Bilibili（唯一的真难源，单独立项）

实测结论（比预想更糟，值得完整记录）：

| 请求 | 结果 |
|---|---|
| `/x/space/wbi/arc/search?...`（带正确 WBI 签名） | `{"code":-352,"message":"风控校验失败","data":{"v_voucher":...}}` |
| `/x/polymer/web-dynamic/v1/feed/space?host_mid=242124650` | **HTTP 412** 触发风控 |
| `/x/space/acc/info` | `-799 请求过于频繁` |
| 几次之后整个 host | `{"code":-412,"message":"request was banned"}` |
| `/x/relation/stat?vmid=`、`/x/space/navnum?mid=`（**无需签名**） | 200 ✅ |

WBI 本身不是门槛（算法已跑通：`nav` 取 `wbi_img` → `imgKey+subKey` 按 64 位表置换取前 32 位得 `mixinKey`，参数排序过滤 `!'"()*` 后 `w_rid = md5(query + mixinKey)`）。真正拦人的是 **`dm_img_*` 设备指纹 + cookie/登录 + IP 风险评分 + WAF ban**。而且公共 `rsshub.app` 实例对自动客户端是 **403 + Cloudflare challenge**，不能指望它。

因此三条路，按推荐度：

1. **自建 RSSHub**（Docker Compose 常驻，路由 `/bilibili/user/video/242124650`，可加 `?format=json`）：它已经实现了 WBI + `dm_img_*` + cookie 注入 + **API 失败时回退到真实浏览器**。代价是引入一个外部常驻进程。
2. **插件内 WBI + SESSDATA cookie**：技术上可行（算法已验证），但属于「随时会失效」的代码，而且拿不到指纹参数时就是上面那张表的下场。
3. **降级为「变更通知」**：用那两个**不需要签名**的接口（`/x/relation/stat` 粉丝数、`/x/space/navnum` 投稿数）做轮询。投稿数一变，就产生一条「UP 主有新投稿」的条目，把投稿页链接交给用户/Agent 去打开。**零风控风险、能覆盖 90% 的实际需求（"他更新了没"）**。

> 建议：**B 站放 P3，先做方案 3**。方案 3 只用一个不需要签名的接口，成本极低，且不会像爬取那样招来 IP ban。真要完整列表再上方案 1。

---

## 7. UI 面（全部落在现成 Slot 上）

已用 `Slots.listSubTree` 核对过实际槽位：

| Slot | 类型 | 用途 |
|---|---|---|
| `main`（keyed，已占用 `plugins`/`conversation`） | keyed，只收 `key` | **工作台主页**：注册 `{ key: 'workbench' }` |
| `sidebar.panellist` | list（`id`/`order`/`label`） | 注册 `{ id: 'workbench', label: '工作台', order: N }`；**catalog 明确写了「list id 对应同名 main 面板，侧栏自己拥有按钮并从 list 元数据取标题」**，所以导航会自动接通，图标组件收到 `{ size, active }` |
| `settings.section` | list | 工作台设置页（源开关、频率、key、早报时间） |
| `settings.general.item` | list | 若只有一两个开关，也可直接在「通用」里加一行 |
| `sidebar.right.pane.tab` | keyed | 以后可放「和 AI 聊这条」的右栏页 |
| `conversation.input.dock` | list | 以后可放「今日 N 条更新」提示条 |

主面板与侧栏图标都能从 standard props 拿到 `usePanelInfo` / `useResource` / `useSessions` / `useSessionStatus` / `useWorkspaces`。

**主页内容（v1 就够）**：左筛选（源 / 分类 / 时间窗 / 只看未读 / 只看精选）、中间列表（标题、源、时间、分数、推荐理由、已读态、星标）、右侧详情（摘要 + 原文链接 + 「复制给 AI」）。
顶部：`手动刷新`、`上次更新时间`、每源状态点（正常/降频/报错）。

**必须遵守的 UI 约定**（来自 `references/practices.md`，已读）：

- 只渲染 React 组件进 Slot，**不要**用 iframe 内嵌宿主 HTML 页面。
- 只用主题 token `--dsw-alias-*`，不写字面色值（除非是插画）。
- **不要** import 任何 Harness Client 包（如 `dsh-client-ui-primitives`）；自己写控件、抄宿主的标记与交互（含 `role="switch"`/`aria-checked`、Modal 焦点与 Esc），类名加自己前缀。
- 用 `ctx.slots.inject(ownerKey, () => ctx.slots.register(...))`，让注册随声明折叠而卸载。
- 可见文案走 Client locale 服务；明暗主题都要看一遍。

### 7.1 UI ↔ Host 的通道（已定方案）

先排除两条看起来更顺、实际不行的路：

- ❌ **自定义 `ctx.remote.<namespace>`**：需要业务包继承 `TypertRemoteService`、用 `@Remote` 标注、并产出生成的 InvocationDescriptor，还要进 `@deepseek-ai/dsh-api-remotes` 的名单。对纯 JS 本地 bundle 太重，且属于会随版本漂移的内部约定。
- ❌ **`host.call(...)`**：这个「包私有 Client→Host RPC」只给**动态 Cordis 包**用（`cordis_define` 那条路），而那类包刷新页面就不恢复、UI 只能渲染在 `tool.view.cordis` 卡片里。不适合常驻工作台。

**采用：同一个包里 Host 半注册 HTTP 路由，Client 半 `fetch`。**

Host 半（`ctx.webServer` 服务已确认存在）：

```js
ctx.effect(() => ctx.webServer.register({
  kind: 'prefix',
  path: '/workbench',
  handler: async (req, res) => { /* Node 原生 (req,res)，自己写 JSON 响应 */ },
}));
```

路由表：

| 方法 | 路径 | 用途 |
|---|---|---|
| GET | `/workbench/items?source=&category=&window=&unread=&starred=&q=&cursor=` | 列表查询（分页） |
| GET | `/workbench/sources` | 源清单 + 健康状态（`lastOkAt`/`failStreak`） |
| GET | `/workbench/meta` | UI 初始化（版本、上次刷新、源总数、未读计数） |
| POST | `/workbench/refresh` | 手动触发（可指定源） |
| POST | `/workbench/state` | 标记已读/未读/星标/隐藏 |
| GET | `/workbench/events` | SSE，推 `workbench/changed`（首次连上先推一次快照摘要） |

Client 半就是 `fetch('/workbench/...')` + `EventSource('/workbench/events')`。好处：

- 纯 JS 可写，零生成产物，版本升级不易碎；
- 可流式（SSE）拿到实时更新，不用轮询；
- **同一套 core 方法同时服务 UI 和 Agent 工具**，不会出现「UI 看到的」和「模型看到的」两套逻辑。

更贴合宿主习惯的一层精修（可选，P3）：Host 数据就绪后，Client 半用 `ctx.resources.register({ protocol: 'workbench', async *open(address, {signal}) {...} })` 注册一个 `dsh-resource://workbench/...` 协议，组件统一走 standard prop `useResource`。这样列表/详情各自成为一个可 pin 的活资源，切换视图不重开流、不重抓。

待验证项：`prefix` 路由与 SPA fallback（`registerFallback` 由 dist server 占用）的优先级；以及本地回环下的信任面（`ctx.connection.admit` / `authorizeIndex`）。P0 第一件事就是用一个最小路由打通它。

---

## 8. 与 Agent 的集成（这才是「工作台」相对普通 RSS 阅读器的增量）

1. **Host 工具**（`ctx.tools.register`，模型可直接调）：
   - `workbench_brief({since, sources?, unreadOnly?})` → 结构化更新摘要（供写早报）
   - `workbench_search({q})` → 本地全量检索（比联网搜更快更准，因为是你订阅的源）
   - `workbench_refresh({source?})` → 手动触发抓取
   - `workbench_read({id})` → 取单条正文/字幕（懒抓取 + 缓存）
   - `workbench_sources()` → 源清单与健康状态
2. **每日早报**：`ctx.schedule` 已确认支持 `daily {time, time_zone}` / `cron` / `every` / `at` / `after_seconds`，且投递就是「往绑定会话塞一条 prompt」。所以早报不需要在插件里写 LLM 调用：
   - 你的 profile 里**已经有 `schedule_create` / `schedule_list` / `schedule_update` / `schedule_delete` 这套工具**，所以「每天早上 8:30 给我一份工作台早报」这句话，模型直接用现成工具就能建，工作台只要提供 `workbench_brief` 就行。
   - 插件再提供一个便利工具 `workbench_subscribe_digest({time})`：内部 `ctx.schedule.create(exec.agent.id, { daily: {...}, title: '工作台早报', prompt: '调用 workbench_brief 取过去 24h 更新，按主题分块写一份中文早报……' })`——省得用户每次复述 prompt。
   - 好处：早报内容本身进了会话日志，可回看、可追问、可 fork；模型判断力也优于插件里的启发式。
3. **不要在插件里做 LLM 打分**。AIHOT 已经给了 `score` + `reason`；其余源用「源权重 × 新鲜度 × 关键词规则」先排，真要语义排序就交给 §8.2 的早报会话。
4. **事件**：`workbench/changed` 供 UI 与其它插件订阅；条目的 `contentRef` 让「打开一条 → 和 AI 讨论」不用重新抓一遍。

---

## 9. 分阶段计划

| 阶段 | 交付 | 验收标准 |
|---|---|---|
| **P0 骨架** | core（域+出网+注册表）+ `source-aihot` + 主页列表（筛选/刷新/已读） | 打开页面能看到 AIHOT 精选条目；刷新有增量；重启后数据还在 |
| **P1 多源** | `source-rss`（通用）+ youtube + hf-papers + producthunt；设置页；星标/已读；每源状态与退避 | 4 个源各自开关生效，关掉哪个都不影响其它 |
| **P2 Agent 化** | 五个工具 + 早报订阅 + `workbench/changed` + 跨源去重；可选 Markdown 导出 | 一句「开每天 8:30 的工作台早报」→ 次日会话里收到成稿早报 |
| **P3 难源与打磨** | bilibili（RSSHub 或 WBI）、Firecrawl 兜底、正文抽取、SSE 实时、右栏「和 AI 聊这条」 | 新增一个源不需要改 core 与 UI |

**待验证项（写代码前先确认，避免返工）**
1. `defineDomain` 从哪个包导出、以及它在纯 JS 插件里的用法 —— 已绕过，见 §14.2。
2. `install_bundle` 是否安装 bundle 的 npm `dependencies` —— 已确认会装，但见 §14.1：链接安装下裸导入解析不到。

**已核对，不再是未知项**
- ~~`main` 槽位怎么被选中~~ → `sidebar.panellist` 的 id 直接寻址同名 main 面板，宿主侧栏自己渲染按钮；**已在真机验证**（§14.3）。必要时 `ctx.layout.selectPanel('workbench')`。
- ~~工具怎么拿到发起会话~~ → `execute(args, exec)` 里 `exec.agent.id` 就是 SessionId。
- ~~UI 怎么找 Host 要数据~~ → **`ctx.webServer.register({kind:'prefix'})` 已实测可用**（§14.1）。
- ~~早报要不要自己调模型~~ → 不用，`ctx.schedule` 的 daily 任务把 prompt 投进会话即可。
- ~~key / cookie 怎么存~~ → `CredentialRef` 就是「环境变量名」这个 branded string，`await ctx.credentials.resolve('FIRECRAWL_API_KEY' | 'BILIBILI_SESSDATA')` 即可（每次操作前重新 resolve，不要跨操作缓存）；`describe()` 给设置页用，不暴露值。

---

## 10. 风险清单

| 风险 | 影响 | 缓解 |
|---|---|---|
| 外部站点改版/反爬升级 | 单源失效 | 源隔离 + 健康状态可见 + 降频而非崩溃 + 兜底阶梯 |
| B 站风控 | 该源长期不可用 | 放 P3，先做「投稿数变化通知」（用免签名的 `navnum`）；或交给 Agent 按需抓 |
| AIHOT 条款 | 合规 | 个人非商业免费；保留 attribution 与 canonical 链接；不外发、不做公开镜像 |
| **抓到的内容里带提示注入** | 模型被外部文本操纵 | §5.1：当数据不当指令 + 每条带来源与原文链接 + 自动行为只由配置驱动 |
| Firecrawl `maxAge` 默认 2 天 | 静默拿到旧页面 | 轮询一律显式传 `maxAge: 0`（§5） |
| 依赖膨胀 | profile 变重、升级易碎 | P0 零依赖；只在「待验证项 1」确认后再引 |
| UI 通道残留不确定性 | 主页数据拿不到 | 通道已选定（HTTP 前缀路由）；P0 第一件事就是用最小路由验证前缀优先级 |
| 数据无限增长 | 域存储膨胀 | 每源条数/天数上限 + starred 豁免 + 正文单独限额 |
| DSH 未运行时停更 | 早报可能空 | 启动即补抓（`since = lastOkAt`）；早报 prompt 里标注「若超过 X 小时未更新先刷新」 |

---

## 11. 待你拍板的决策点

我把每个选项的调研结论都写上了，你直接挑：

1. **主界面形态**：中央主面板页（推荐｜信息密度最高，`main` + `sidebar.panellist` 一对注册就自动接通）还是只用右侧栏？
2. **出网兜底策略**：
   - **A（推荐）** 只走原生 API/RSS + readability 兜底 + **Firecrawl 免费档 1000 credits/月**救急。$0，覆盖你列的 5 个源绰绰有余。
   - B 现在就认真接 Firecrawl（Hobby $19/月 = 5000 页）—— 除非你还要抓 X/Twitter 或一堆强反爬站，否则用不上。
   - C 完全不接第三方，全靠自己 + 交给 Agent 按需抓。最干净，但遇到 JS 壳页面会卡。
3. **数据落盘**：Harness 域存储为主（推荐）还是直接落工作区 Markdown/JSON 文件（可 grep、可 git、Agent 可直接 read）？也可以「域存储为主 + 每天导出一份 Markdown」。
4. **采集时机**：只在 DSH 运行时轮询（推荐，零外部依赖）还是希望 DSH 关着也更新（需要 Windows 计划任务 + headless 入口）？
5. **P0 范围**：先只打通「AIHOT + 主页」一条竖切（推荐，最快看到东西），还是一次把 4 个易源都做上？

6. **B 站方案**：按「投稿数变化通知」的降级方案做（只用免签名的 `/x/space/navnum`，投稿数一变就提示「他更新了」，链接交给 Agent 去读），还是现在就上自建 RSSHub？

> 以上 6 项都已在 §12 记录为定案。

---

## 12. 已确认的决策（2026-10-03）

| # | 决策点 | 选定 |
|---|---|---|
| 1 | 主界面形态 | **中央主面板页 + 侧栏图标**（`main` key=`workbench` + `sidebar.panellist` id=`workbench`） |
| 2 | 出网兜底策略 | **A：原生 API/RSS + readability 兜底 + Firecrawl 免费档（1000 credits/月）救急** |
| 3 | 数据落盘 | **Harness 域存储为主**（暂不做 Markdown 导出，留到 P2） |
| 4 | 采集时机 | **只在 DSH 运行时轮询**（自重排 setTimeout + 启动补抓） |
| 5 | P0 范围 | **先打通「AIHOT + 主页」一条竖切** |
| 6 | B 站方案 | **降级为「投稿数变化通知」**（免签名 `navnum`），P3 |

---

## 13. P0 实施规格

### 13.1 目录与文件

工作区里建 `workbench/`，P0 只有一个包：

```
workbench/
  package.json          # 见下
  cordis.patch.yml      # 一行 insert
  index.js              # Host 半：core + aihot 源 + 路由 + 工具
  client.js             # Client 半：window.__ModuleLoader__.load({...})
```

`package.json`：

```json
{
  "name": "dsh-my-homepage",
  "version": "0.1.0",
  "private": true,
  "type": "module",
  "exports": { ".": "./index.js", "./client": "./client.js" },
  "dsh": {
    "bundle": { "patch": "./cordis.patch.yml" },
    "client": { "platform": "web", "immediately": true, "inject": [] }
  }
}
```

`cordis.patch.yml`：

```yaml
- insert:
    - id: workbench
      name: 'dsh-my-homepage'
```

安装：`plugin_manager` `install_bundle`，`target` 传 `workbench/` 的绝对路径。一次安装，插一行。

### 13.2 Host 半（`index.js`）要做的事，按顺序

1. **声明依赖**：`export const inject = ['storageDomain', 'webServer', 'tools', 'timer']`（`credentials` / `schedule` 走 `ctx.get()` 可选检查，避免在没装它们的 profile 里整包不激活）。
2. **开域**：用 `defineDomain({ name: 'workbench', version: 1, tables: {...} })`（从 `@deepseek-ai/dsh-storage-domain` 导出）声明 `items` / `sources` / `read` 三张表 + `global`，然后 `await ctx.storageDomain.open(spec)`，并把 `domain.close()` 挂进 `ctx.effect` 的清理里。
3. **注册路由**（P0 第一个要验证的东西）：
   ```js
   ctx.effect(() => ctx.webServer.register({
     kind: 'prefix', path: '/workbench',
     handler: async (req, res) => { /* 手写 JSON 响应 */ },
   }));
   ```
   先只做 `GET /workbench/ping` 返回 `{"ok":true}`，确认它不被 SPA fallback 吃掉、且浏览器能取到。
4. **出网层**：`fetchJson(url, {etag})` —— 用全局 `fetch` + `AbortSignal.timeout(20000)` + `Accept-Encoding` + `If-None-Match`，304 返回 `{notModified:true}`。
5. **源注册表**：`sources = new Map()`，`registerSource(provider)` 返回 disposer；P0 只注册 aihot。
6. **AIHOT 源**：
   - **用 `/api/v1/items?mode=selected&window=7d&by=timeline&limit=100`**，不要用 `selected/snapshot` + `changes`。
     原因（实测纠正）：OpenAPI 规范里 `Item.reason` 写着 *"Selected snapshot and changes do not include this field yet"* —— 而「推荐理由」正是这个工作台最值钱的展示字段。`/items` 总是带 `reason`，代价只是每次多传一点 JSON，60s 的 `s-maxage` 和 ETag/304 已经把这个代价压到很低。
   - 归一化成 `WorkbenchItem`，`id = 'aihot-' + item.id`（**不能用冒号**，见 §14.2），`url = links.original`，`summary`/`score`/`reason`/`attribution` 原样透传。
   - `sources` 表存 `etag` / `lastOkAt` / `lastError` / `failStreak`。
   - 轮询：自重排 `setTimeout`，间隔取 `max(60s, s-maxage)`（P0 先用 10 分钟）。
7. **查询**：`query({source, unreadOnly, q, limit})` 在 `items` 表上过滤后按 `publishedAt` 倒序。
8. **标记**：`markState(ids, {seen, starred, hidden})` 写 `read` 表。
9. **工具**：P0 先只注册 `workbench_brief`（`{since, unreadOnly}` → 结构化更新列表）和 `workbench_refresh`。`execute(args, exec)` 里用 `exec.agent.id` 拿会话。

### 13.3 Client 半（`client.js`）要做的事

1. `window.__ModuleLoader__.load({ id: 'dsh-my-homepage', factory(require) { ... } })`，`const React = require('react')`。
2. 返回 `{ inject: ['slots'], apply(ctx) {...} }`，在 `apply` 里用 `ctx.effect` 挂两处注册：
   - `ctx.slots.inject('sidebar.panellist', () => ctx.slots.register({ name: 'sidebar.panellist', id: 'workbench', order: 50, label: '工作台' }, Icon))` — `Icon` 收 `{size, active}`，画一个内联 SVG。
   - `ctx.slots.inject('main', () => ctx.slots.register({ name: 'main', key: 'workbench' }, Panel))`。
3. `Panel`：`useState` + `useEffect` 拉 `/workbench/items`，渲染三栏（筛选 / 列表 / 详情）。点击条目标已读（`POST /workbench/state`）。
4. 样式：只引 `--dsw-alias-*` token；用 `styles.insert(css)` 或在 `apply` 里注入一个 `<style>` React 元素。文案先硬编码中文（`ctx.locale` 可选化留到 P1）。
5. **不要** `require` 任何 `@deepseek-ai/dsh-client-*` 包。

### 13.4 验证步骤（按这个顺序，每步都别跳）

1. `install_bundle` 的结果里读 `application` 与 `warnings` —— 必须是 `applied`。
2. `cordis_inspect_query` client `Slots.listSubTree` root=`main`，确认 `workbench` 出现在 `occupants`；同样确认 `sidebar.panellist` 多了一行 `id: workbench`。
3. 浏览器打开本机 URL，点侧栏新图标 → 应切到工作台页面；看控制台有没有 `slot entry crashed`。
4. `GET /workbench/ping` 能返回 JSON —— 这一步确认前缀路由优先级（P0 唯一的真未知数）。
5. 触发一次刷新，确认条目落进域存储；重启 DSH 后条目还在。
6. 明暗主题各看一遍，确认只用 token 没有硬编码颜色。

### 13.5 P0 的完成判据

- 侧栏有「工作台」图标，点开是中央主面板；
- 面板里能看到 AIHOT 精选条目（标题 / 来源 / 时间 / 分数 / 推荐理由），能按未读筛选；
- 点「刷新」能拉到增量（第二次刷新命中 ETag 返回 304，`lastNotModified: true`）；
- 重启 DSH 后数据还在；
- 会话里让模型调 `workbench_brief` 能拿到结构化更新列表。

---

## 14. P0 实施记录（实测纠正）

代码在 [`workbench/`](../workbench/)，一次 `install_bundle` 即装上，`application: applied`。

### 14.1 被验证成立的

| 结论 | 证据 |
|---|---|
| **HTTP 前缀路由可用**（P0 唯一的真未知数） | `GET /workbench/ping` → `{"ok":true,"ready":true}`，没有被 SPA fallback 吃掉，回环下也不需要额外授权 |
| **存储域能开** | `ctx.storageDomain.open(纯对象 spec)` 成功，默认 backend 会被路由到（`dsh-storage-domain/lib/index.js:359` 是 `routes[spec.name] ?? config.backend`） |
| **Host 进程能出网** | 同一个进程里 `fetch` 拿到 100 条 AIHOT 条目并落库（`added: 100`） |
| **侧栏图标 + 主面板自动接通** | 只注册 `sidebar.panellist{id:'workbench'}` + `main{key:'workbench'}`，`Slots` 巡检里 `workbench` 直接成为 active occupant，没写任何导航代码 |
| **Client 半热重载** | 改完 `client.js` 无需刷新页面，侧栏条目就出现了（宿主按 mtime/size 算 revision） |
| **工具能注册并被模型看到** | `workbench_brief` / `workbench_refresh` / `workbench_sources` 三个工具当场出现在可用工具表里 |
| `output.render` 的 ContentBlock 形状 | `[{ type: 'text', text }]` 被接受 |

### 14.2 踩到的坑（都已修）

1. **`per-record` 布局的 key 必须匹配 `/^[a-zA-Z0-9_-]+$/`** —— 用冒号做源分隔符（`aihot:xxx`）会被后端直接拒：
   `unit 'workbench': per-record key 'aihot:...' is not path-safe`。
   → 改成 `aihot-<id>`，并且统一走一个 `itemKey()` 做字符净化（未来别的源 id 里可能有 `.` 或 `/`）。
   **这条对 `read` 表同样成立**，因为它的 key 也是条目 id。
2. **Host 模块体是按 specifier 缓存的，改 Host 代码必须重启 DSH。** 实测 `set_bundle` 禁用再启用会重新执行 `apply()`（`runs` 归零、路由重新注册），但**模块体还是旧的那份**，所以 `normalize()` 的修复没有生效。客户端相反：改 `client.js` 立刻生效。
   → 开发节奏：Host 改动攒一批再重启；UI/版式改动可以实时迭代。
   → 另外 dsh 启动**不带** `--preserve-symlinks`，所以 `install_bundle` 的 `link:` 安装下，插件里的**裸导入会从工作区目录往上找**，找不到 profile 的 `node_modules`。这就是 `index.js` 零导入的原因：zod 用 `{ parse: v => v }` 顶替（域对它只调用 `.parse()`，`dsh-storage-domain/lib/index.js:371`）。以后要引依赖，得先解决这个解析问题（或把包放进 profile 目录而不是链接）。
3. **`/workbench/refresh` 实测 100 条全带 `reason`**，验证了 §13.2 里改用 `/api/v1/items` 的判断（`selected/snapshot` + `changes` 至今不带这个字段）。

### 14.3 一个可复用的开发手段

`workbench/dev/selftest.mjs` 用假 `ctx`（假的 `storageDomain.open` / `webServer.register` / `tools.register` / `effect`）直接跑真的 `apply()`，并用假 `req`/`res` 打自己注册的路由。

因为它，那个「key 不是 path-safe」和「handler 没返回 promise」两个问题在**重启之前**就被抓住了 —— 20 项检查全绿：

```
PASS  route registered / tools registered / no effect warnings
PASS  GET /ping -> 200     PASS  POST /refresh -> ok  -> {"added":100,...}
PASS  item keys are path-safe -> aihot-cyq72z49wj36fz07iy6o4mvok, ...
PASS  reason present (from /items, not the snapshot API) -> 54 chars
PASS  POST /state -> ok    PASS  state round-trips -> {"seen":true,"starred":true,...}
PASS  workbench_brief returns items -> count=3
PASS  meta reports a healthy source -> {"fail":0,...}
```

两个注意点：假 ctx 的 `effect` 如果不 dispose，插件那个 10 分钟的轮询 `setTimeout` 会让 node 永远不退出（第一版就是这样挂住的，现已补上 teardown）；假的 KV 表必须**照抄后端的 key 校验**，否则这个测试就抓不到 §14.2.1。

**这条经验值得推广**：Host 代码有「改了要重启」的代价，所以在重启之前先用假 ctx 把逻辑跑一遍，比反复重启快得多。

### 14.4 版式：从「阅读器」改成「小组件工作台」

第一版做成三种阅读器版式（三栏/时间线/看板），被否掉了。方向应该是**个人主页式的小组件面板**：浅色底、白色圆角卡片、大小不一的 bento 网格、每卡左上角一个标签 chip、留白足但信息密度高。

所以现在是这样两件事：

**一、`widget` 声明是源注册表的一部分 —— 这才是「组件化」。**
每个源在 `index.js` 的 `SOURCES` 里除了「怎么抓、多久抓一次」，还声明**它要哪张卡**：

```js
{
  id: 'aihot', label: 'AIHOT 精选', cadenceMinutes: 10,
  widget: { kind: 'feed', colSpan: 2, rowSpan: 2, title: 'AIHOT 精选', hint: '编辑精选 · 带推荐理由' },
  async load(signal, previous) { … },
}
```

`GET /workbench/meta` 把这些描述符原样交给客户端，`client.js` **照着描述符渲染网格** —— 加一个源就多一张卡，客户端一行都不用改。

**第二版的关键修正：一个源一种卡片形态，不是一种通用列表。**
第一版所有源都渲染成同一个列表，被指出「视觉上不够好，可能都是文字的原因」+「你要根据不同的消息源设置不同的小组件」。所以现在每种数据形态有自己的卡片：

| `kind` | 用在 | 卡片长什么样 |
|---|---|---|
| `feed` | AIHOT 精选 | **图片主导的新闻卡**：封面图（带分类角标）→ 来源徽标 + 名称 → 加粗标题 → 摘要 → 元信息条；前 3 条是卡片，其余收成紧凑行 |
| `papers` | HF 论文 | 2 列网格，**HF 真实论文封面** + 标题 + `作者 · ▲ 赞 · N 评论` |
| `media` | YouTube | 16:9 封面 + **播放角标** + 标题 + `时间 · 观看数`，横排一行一条 |
| `products` | Product Hunt | **方形字母徽标** + 产品名 + 一句话 tagline |
| `rank` | AIHOT 热榜 | 2 列**编号列表**（01/02/03 大号等宽数字，前三名用品牌色），不用图 —— 数字本身就是视觉 |

**第三版又加了一层：封面图从哪来。**

| 源 | 真实图片 | 结论 |
|---|---|---|
| YouTube | `i2.ytimg.com/vi/<id>/hqdefault.jpg` | ✅ 实测 200 image/jpeg，用真视频封面 |
| HF 论文 | `cdn-thumbnails.huggingface.co/social-thumbnails/papers/<id>.png` | ✅ 实测 200 image/png（约 300KB） |
| AIHOT | 接口不提供图片字段 | ❌ → **按 id 派生封面渐变** + 来源首字 |
| Product Hunt | feed 里没有图片 | ❌ → 同上，方形字母徽标 |

两个刻意的取舍：

- **不做 favicon**。实测直连 `openai.com/favicon.ico` 返回 **403**，而且有的站点 favicon 有 200KB+（Product Hunt / HuggingFace 都是）。改成**按名称派生的字母徽标**：零请求、永不失效、深浅两色都成立，还能顺带标出「这条来自哪个站」。
- **渐变封面用半透明色**（`hsla(...,.82/.70)`）。因为不知道当前是明色还是暗色主题，半透明色叠在卡片底色上会自动适应两边。这是「要有封面感」与「只用 token」之间的折中；属于装饰性 artwork，token 规则允许。

**三、网格与卡片语言**

| | |
|---|---|
| 网格 | `repeat(4, minmax(0,1fr))` + `grid-auto-rows: 92px` + `grid-auto-flow: dense`；卡片自报 `colSpan`/`rowSpan`，密集回填 |
| 卡片 | `--dsw-alias-bg-layer-1` 底、18px 圆角、1px `border-l1`、柔和阴影、hover 微微抬起 + 封面图轻微放大 |
| 卡片头 | 左上角 chip（小圆点 + 标题 + 灰字说明），右上角「全部 →」 |
| 页面 | hero 一条：46px 圆角方块 + 「早上好」+「今天 N 条新内容 · M 条未读」+ 状态胶囊 + 刷新；下面是**分类 chip 行**（`#模型 #产品 #行业 #论文 #技巧`）+ 搜索框 |
| 焦点 | 顶部一张全宽「今日焦点」卡（4×3）：左半边大封面 + 分类角标，右半边标题/摘要/评分/读原文 |
| 详情 | 点「全部 →」开覆盖式 Reader sheet（Esc 关闭），**每行也带缩略封面** |

这一版正好铺满 4×10：今日焦点 4×3、AIHOT 2×4、热榜 2×2、HF 2×2、Product Hunt 2×2、Dwarkesh 2×2、今日新增/未读/本地时间/信息源 各 1×1。**

> **阴影与主题**：参考图的通透感靠阴影，但 14 个 token 里没有阴影。做法是 `rgba(0,0,0,.04/.20)` 的低透明度阴影 —— 暗色下它几乎不可见（无害），暗色的层次由 `layer-1` 与 `border-l1` 的对比承担。这是「只用 token」与「要有参考图那种质感」之间的折中。

### 14.5 第二轮又抓到的四个问题

| 问题 | 现象 | 处理 |
|---|---|---|
| **转义 HTML 没被清掉** | Product Hunt 的 `<content>` 是「XML 里再转义一层 HTML」，先剥标签再解实体会把 `<p>` 原样留在摘要里 | 顺序反过来：**先解实体、再剥标签**（`feed.js`，由 fixture 测试抓出） |
| **没有并发去重** | 重写时丢掉了 in-flight 判断，轮询和手动刷新会同时打同一个源 | 每源一个 in-flight promise，第二个调用者复用在跑的 promise |
| **没有全局并发上限** | 本机代理偶发 `UND_ERR_CONNECT_TIMEOUT`（实测 3 次里挂 1 次），两个源同时抓就容易翻 | 全局最多 2 个并发抓取，超出的排队 |
| **失败退避太狠** | 一次瞬时网络错误就让该源等满整个周期（YouTube 是 3 小时） | 首次失败改成 1 分钟重试，2/4/8… 分钟递增，只有持续失败才落到正常周期 |

第 2、3、4 条都是那轮「3 次探针挂 1 次」复现出来的 —— 也说明本机这个代理不是稳定网络，抓取层必须把「瞬时连接失败」当常态而不是异常。

### 14.6 自测现状

`node dev/selftest.mjs` —— **40/40 通过**，退出码 0。除了原来的路由/工具/存储/工具输出，现在覆盖：

```
PASS  atom: link from rel=alternate href / entities decoded / html stripped out of content
PASS  rss: CDATA unwrapped / guid preferred as id / media:thumbnail / media:statistics views
PASS  meta describes the grid (source -> widget) -> aihot:feed 2x2 | aihot-hot:rank 1x2 | ...
PASS  default listing excludes rank rows  -> 107 articles
PASS  rank rows carry their rank in metrics
PASS  every stored key is path-safe
-- 全部 5 个源联网实拉 --
   ok  aihot added=60 | aihot-hot added=10 | hf-papers added=20 | producthunt added=15 | youtube added=12
```

注意 fixture 测试的价值：那个「转义 HTML」的 bug 是**离线 fixture**（不需要网络）抓出来的，而且它正好是 Product Hunt 这一类源的真实形态 —— 如果没有 fixture，只有等到肉眼看摘要里带 `<p>` 才会发现。

### 14.7 用 agent-browser 做视觉验证（这一轮最大的方法论变化）

前面几轮我一直只能说「我看不到渲染结果」。装上 `agent-browser` 之后这个缺口补上了，而且第一次看就发现**肉眼比数字更能说明问题、但数字能定位肉眼看不出的原因**。

**怎么进得去**：DSH 的 Web 服务要一个会话，`/` 无 cookie 时返回 `401 dsh web authentication required`。认证是 `?token=` 查询参数换签名 cookie（`dsh-client-connection/lib/index.js:388`），而这个 token 是**进程级 `randomBytes()`**（同文件 `:244`，module-level WeakMap），**只 `console.log` 一次，不落盘**。签名密钥确实durable在凭据库里，也就是「读你的密钥、自己伪造一个 cookie」在技术上可行 —— **我没做**，那是另一回事。正解是让用户从启动 `dsh web` 的终端里把那一行贴过来。

两个操作坑：
- **不要用 `wait --load networkidle`**：DSH 页面常驻 WebSocket，网络永远不会 idle，会直接挂住（我第一次就挂了 180s）。
- `eval` 的脚本在**同一个全局作用域**里反复执行，用 `var`/`const` 声明变量第二次就会 `Identifier already declared`，要用 IIFE 包起来；含引号的脚本用 `eval -b <base64>` 最稳（PowerShell here-string 喂 `--stdin` 会把脚本搞坏）。

**看到的问题，以及它们各自的性质**（这次全部有测量支撑）：

| 现象 | 测量 | 根因 |
|---|---|---|
| 卡片内容被切掉 | AIHOT 卡片 `innerScroll=693`、HF `833`、PH `700` | 行高 92px 太小 + 每个组件渲染的条数远超卡片高度 |
| 今日焦点里一根细长条 | `getBoundingClientRect().width ≈ 30` | `Cover` 在横向 flex 里没有 `width` → 塌成内容宽度 |
| 数字被切一半 | 1×1 卡片内容需要 113px，卡只有 92px | 1 行卡片只剩 32px 正文，装不下 30px 数字 + 标签 |
| 颜色发脏 | 焦点卡是橄榄绿 | 封面色相来自 **item id 的哈希** → 每个条目一个随机色 |
| 浅色下白字看不见 | — | 封面是**半透明淡色**，白字在上面没有对比度 |

**修的地方，以及一条架构结论**：

1. **尺寸改成「按 kind 决定」**。`WIDGET_KINDS` 里每种 kind 自带渲染器与默认尺寸，**客户端忽略宿主声明的 `colSpan`/`rowSpan`**。理由是被实测逼出来的：宿主的宿主模块是按 specifier 缓存的，旧一代声明里 `hf-papers` 的 kind 恰好是 `feed`（新词汇表里也存在），于是「未知 kind 才回退」的规则失效，卡片拿到了旧的 2 行高继续被切。**尺寸是展示层的事**，宿主负责说「这是什么形态」（kind），客户端负责「它多大」。同时加了 `widget.layout: 2` 作为世代标记：有它就以宿主 kind 为准，没有就按 source id 推断（`LEGACY_KIND`，等宿主更新后可删）。
2. 行高 92 → **112**，`media` 改成横排（竖排两张封面塞不进 2 行）。
3. `Cover` 加 `width: 100%`；没有真图时不再显示一个大色块 + 巨大首字母，而是**让色块承载真实信息**（焦点卡放「83 / AIHOT 评分」，列表首条放评分横幅）。
4. 封面色相改成**按分类固定配色**（行业蓝 / 模型紫 / 论文洋红 / 技巧琥珀…），同一分类的色块一致，不再是随机色。
5. 淡色底上的文字改用主题 label token，浅色深色都有对比度。

**验证方式（可复用）**：用一段 IIFE 的 `eval` 遍历 `section.wb-card`，报告每张卡的 `gridColumn`/`gridRow` 和 `scrollHeight - clientHeight`，**要求全为 0**；再配合 `set media light|dark` 各截一张图。最终结果：

```
今日焦点 4x2 ov=0 | AIHOT 精选 2x4 ov=0 | 热榜 2x2 ov=0 | HF 论文 2x2 ov=0
Product Hunt 2x2 ov=0 | Dwarkesh 1x2 ov=0 | 今日新增 1x1 ov=0 | 本地时间 1x1 ov=0 | 信息源 2x2 ov=0
overflowing: []
```

**顺带纠正一个之前的判断**：我先前说「要重启才能看到新源的数据」是**错的**。实测 `/workbench/meta` 返回 `itemCount: 117 / articleCount: 107`，5 个源全部抓到了（信息源组件里能看到 60/10/… 的条数条）。宿主模块是哪个世代、和它有没有数据，是两件事。重启只为拿到 v4 的 kind 声明（以及 HF 的真实论文封面），不是为了数据。
