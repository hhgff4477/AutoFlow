# AutoFlow · 内容结构分析

一个跑得通的个人自动化流水线：**信息抓取 → AI 处理与分类 → 结构统计 → 分析报告导出**。

配套一份真实的内容运营分析——**「跨源覆盖度」**：公开 RSS 源不提供阅读量/转发数，所以改用
「报道过某类内容的来源数 ÷ 总来源数」作为可计算的替代口径，来推断"哪类内容值得主打"。

---

## 这个仓库里有什么

```
autoflow/
├── server.js                    # Express 单端口服务：抓取 / AI处理 / 分类 / 归档 / 分析报告
├── public/
│   ├── index.html               # 作品集主页
│   ├── autoflow/index.html      # AutoFlow 工作流界面（含跨源覆盖度模块）
│   ├── analysis/index.html      # 内容结构分析报告（可视化）
│   ├── analysis/data.js         # 报告页数据（由脚本生成，内联，零网络请求）
│   └── assets/                  # 图片素材
└── analysis/                    # 分析管道（离线跑，产出上面那份数据）
    ├── methodology.mjs          # 分析方法论文档（含"为什么用覆盖度替代转发数"的论证）
    ├── batch-classify.mjs       # 批量抓取 + 逐条 AI 分类（断点续跑）
    ├── build-data.mjs           # analysis-data.json → public/analysis/data.js
    └── analysis-data.json       # 分类结果数据集
```

## 快速开始

```bash
npm install
npm start          # 默认 http://localhost:3000
```

| 路径 | 说明 |
|---|---|
| `/` | 作品集主页 |
| `/autoflow/` | 工作流界面（抓取、AI 摘要与分类、下载报告） |
| `/analysis/` | 内容结构分析报告 |
| `/api/health` | 健康检查 |
| `/api/sources` | 信息源白名单 |
| `/api/tags` | 分类体系 |
| `/api/fetch` | 抓取（body: `{ sourceIds, limit }`） |
| `/api/report` | 生成分析报告（Markdown，服务端聚合统计） |
| `/api/archive` | 生成简报归档（Markdown） |

## 重新跑一遍分析

```bash
cd analysis
node batch-classify.mjs 60     # 抓取并分类（每完成一条立即落盘，中断可直接重跑）
node build-data.mjs            # 生成 public/analysis/data.js
```

`batch-classify.mjs` 支持**断点续跑**：已分类的 URL 会被跳过，不会重复消耗模型调用。

---

## 一条刻意的设计原则

**所有聚合统计都由服务端代码计算，绝不采用模型输出的比例。**

模型只负责两件事：给每条内容写一句摘要、打一个分类标签 + 一句归类理由。
"哪类占多少、覆盖度是多少"这类数字，全部由代码聚合得出——**因为报告里的数字必须能被复算**。

同理，「哪类没人看」在页面上被明确标注为**供给侧推断**，而不是受众测量：
公开源拿不到阅读数据，要真验证"有没有人看"，得去内容平台后台看后台数据。

## 分类体系

| ID | 名称 | 说明 |
|---|---|---|
| `tool` | 工具类 | 能上手用的产品、功能、技巧 |
| `opinion` | 观点类 | 对行业/现象的观察与判断 |
| `funding` | 融资商业 | 融资、并购、商业模式 |
| `research` | 技术研究 | 论文、模型、算法进展 |
| `other` | 其他 | 确实无法归入以上任何一类时使用 |

## 技术栈

- **Node.js** + Express（单端口 HTTP 服务）
- 大模型：通过云服务 API 调用（摘要 + 分类）
- 信息源：InfoQ·AI / 爱范儿 / 极客公园 / 少数派 / Hacker News（RSS + Algolia API）
- 前端：原生 HTML/CSS/JS，图表全部手绘 SVG（无图表库、无 CDN 依赖）

## License

MIT
