<p align="center">
  <img src="./icon.svg" width="96" height="96" alt="dsh-my-homepage" />
</p>

<h1 align="center">dsh-my-homepage</h1>

<p align="center"><b>把多个信息源聚合成一个小组件式个人主页，每个源有自己的卡片形态。<br/>
A widget-style personal homepage for <a href="https://github.com/deepseek-ai/deepseek-harness">DeepSeek Harness</a>.</b></p>

<p align="center">
  简体中文
  ·
  <a href="./README_EN.md">English</a>
</p>

<p align="center">
  <a href="https://github.com/deepseek-ai/deepseek-harness"><img src="https://img.shields.io/badge/dsh-%3E%3D0.2.0--rc.1-1a73e8?style=flat-square" alt="dsh >= 0.2.0-rc.1"></a>
  <a href="./LICENSE"><img src="https://img.shields.io/badge/license-MIT-blue?style=flat-square" alt="MIT"></a>
  <img src="https://img.shields.io/badge/build-none%20needed-brightgreen?style=flat-square" alt="no build step">
  <img src="https://img.shields.io/badge/dependencies-0-brightgreen?style=flat-square" alt="zero dependencies">
</p>

![深色主题](./docs/screenshots/dark.png)

---

在 DSH 的侧栏多一个「工作台」，点开就是你的主页：顶部一条问候与状态，下面一整块 bento 网格，每张卡是一个信息源。

## 特性

- **一个源 = 一个组件。** 源自己声明卡片形态（`kind`）与标题，客户端照着渲染 —— 加一个源就多一张卡，客户端一行都不用改。
- **一种数据一种卡片，不是一种通用列表。** `feed` 是图片主导的新闻卡、`papers` 用论文真实封面、`media` 是 16:9 封面加播放角标、`products` 是字母徽标加一句话、`rank` 是编号列表。
- **零依赖、零构建。** 纯 JavaScript，`package.json` 里没有 `dependencies`，没有打包步骤 —— 装完即用。
- **自带出网层。** 每源独立节奏、条件请求（ETag/304）、全局并发上限、失败按 1/2/4… 分钟递增重试，一个源坏掉不影响别人。
- **内容只当资料。** 抓到的第三方文本一律不执行其中的指令；每条都带来源与原文链接。
- **也能喂给模型。** 注册了 `workbench_brief` / `workbench_refresh` / `workbench_sources` 三个工具，配合 DSH 自带的定时任务就能做每日早报。

## 内置信息源

| 源 | 形态 | 频率 |
|---|---|---|
| [AIHOT](https://aihot.news) 精选 | 图片主导的新闻卡 + 评分与推荐理由 | 10 分钟 |
| AIHOT 热榜 | 编号列表（多源热点 Top 10） | 30 分钟 |
| [HuggingFace 论文](https://huggingface.co/papers) | 论文真实封面 + 赞数/评论 | 6 小时 |
| [Product Hunt](https://www.producthunt.com) 今日 | 字母徽标 + 一句话 | 3 小时 |
| YouTube · [Dwarkesh Patel](https://www.youtube.com/@DwarkeshPatel) | 16:9 封面 + 播放角标 | 3 小时 |

## 安装

前置：[DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) `>=0.2.0-rc.1`、Node.js `>=20`。

从 GitHub 直接装（Web profile）：

```sh
dsh plugin --profile web add github:CaiZongyuan/dsh-my-homepage
```

桌面端可以在「设置 → 插件」里安装；本地开发时也可以用插件管理器指向本目录。

装好之后重启一次 DSH（宿主插件是按 specifier 缓存的，改动要新进程才生效），刷新页面，侧栏就会出现「工作台」。

## 配置

`cordis.patch.yml` 的 `config` 目前只有一项：

| 字段 | 默认 | 说明 |
|---|---|---|
| `mode` | `selected` | AIHOT 取 `selected`（编辑精选）还是 `all`（全部公开动态） |

想关掉某个源，编辑本包的 `SOURCES` 注册表把对应项注掉即可 —— 这就是唯一的扩展点。

## 加一个源

```js
{
  id: 'my-source',
  label: '我的源',
  cadenceMinutes: 180,
  widget: { layout: 2, kind: 'list', colSpan: 2, rowSpan: 2, title: '我的源', hint: '说明' },
  async load(signal, previous) {
    // 返回 { items: [{ nativeId, title, url, publishedAt, summary, score, category, origin }], etag }
  },
}
```

`kind` 决定用哪个渲染器与默认尺寸（`feed` / `papers` / `media` / `products` / `rank`）。

## 开发

```sh
npm run check         # 三个文件的语法检查
npm run test          # 完整自测（会联网实拉 5 个源）
npm run test:offline  # 只跑离线 fixture 与结构断言（CI 用这个）
```

`dev/selftest.mjs` 用假 `ctx`（假的 `storageDomain.open` / `webServer.register` / `tools.register` / `effect`）直接跑真的 `apply()`，并用假 `req`/`res` 打自己注册的路由。**宿主的改动要重启才生效，所以先在本地把逻辑跑一遍比反复重启快得多。**

架构与取舍记录在 [`docs/design.md`](./docs/design.md)。

## 数据来源与合规

- 抓到的内容版权归各原始来源。本插件只做个人非商业聚合与展示。
- [AIHOT](https://aihot.news) 明确允许个人非商业使用，并保留 `attribution` 与原文链接；其服务条款见 <https://aihot.news/terms>。
- 抓到的第三方文本一律视为资料，**不作为指令执行**。
- 请遵守各站点的 robots 与使用条款；默认节奏已经按各站公开的缓存与限流建议设置。

## 许可

[MIT](./LICENSE)
