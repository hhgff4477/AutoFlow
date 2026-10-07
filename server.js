import express from 'express'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const PORT = process.env.PORT || 3000

const app = express()
app.use(express.json({ limit: '1mb' }))

/**
 * 公开信息源白名单。
 * 只抓取这些被明确允许的 RSS/JSON 源，不接受前端传入任意 URL
 * —— 否则这个应用会变成一个人人可用的开放代理。
 */
const SOURCES = [
  {
    id: 'infoq-ai',
    name: 'InfoQ · AI',
    category: '行业资讯',
    type: 'rss',
    url: 'https://www.infoq.cn/feed',
  },
  {
    id: 'ifanr',
    name: '爱范儿',
    category: '科技/消费',
    type: 'rss',
    url: 'https://www.ifanr.com/feed',
  },
  {
    id: 'geekpark',
    name: '极客公园',
    category: '科技/创投',
    type: 'rss',
    url: 'https://www.geekpark.net/rss',
  },
  {
    id: 'sspai',
    name: '少数派',
    category: '效率工具',
    type: 'rss',
    url: 'https://sspai.com/feed',
  },
  {
    id: 'hn',
    name: 'Hacker News',
    category: '技术社区',
    type: 'json',
    url: 'https://hn.algolia.com/api/v1/search_by_date?tags=story&hitsPerPage=20',
  },
]

/* ------------------------------------------------------------------ *
 *  极简 RSS / Atom 解析（不引第三方依赖，避免沙箱安装不确定性）
 * ------------------------------------------------------------------ */
function decodeEntities(s = '') {
  return s
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
}

function stripTags(s = '') {
  return decodeEntities(s)
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
}

function pick(block, tag) {
  const re = new RegExp(`<${tag}[^>]*>([\\s\\S]*?)<\\/${tag}>`, 'i')
  const m = block.match(re)
  return m ? decodeEntities(m[1]).trim() : ''
}

function parseRss(xml, limit = 12) {
  const items = []
  const chunks = xml.match(/<(item|entry)[\s>][\s\S]*?<\/(item|entry)>/gi) || []
  for (const raw of chunks.slice(0, limit)) {
    const title = stripTags(pick(raw, 'title'))
    let link = pick(raw, 'link')
    if (!link) {
      const m = raw.match(/<link[^>]*href=["']([^"']+)["']/i)
      if (m) link = m[1]
    }
    const descRaw =
      pick(raw, 'description') || pick(raw, 'summary') || pick(raw, 'content:encoded') || pick(raw, 'content')
    const date = pick(raw, 'pubDate') || pick(raw, 'published') || pick(raw, 'updated')
    if (title && link) {
      items.push({
        title,
        url: link.trim(),
        excerpt: stripTags(descRaw).slice(0, 320),
        publishedAt: date ? safeDate(date) : null,
      })
    }
  }
  return items
}

function safeDate(s) {
  const d = new Date(s)
  return isNaN(d.getTime()) ? null : d.toISOString()
}

async function fetchWithTimeout(url, ms = 12000, accept = '*/*') {
  const ctl = new AbortController()
  const timer = setTimeout(() => ctl.abort(), ms)
  try {
    const res = await fetch(url, {
      signal: ctl.signal,
      redirect: 'follow',
      headers: {
        'user-agent':
          'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36 AutoFlow/1.0',
        accept,
        'accept-language': 'zh-CN,zh;q=0.9,en;q=0.8',
      },
    })
    if (!res.ok) throw new Error(`HTTP ${res.status}`)
    return await res.text()
  } finally {
    clearTimeout(timer)
  }
}

/** 抓取单个源，返回标准化条目 */
async function fetchSource(src) {
  if (src.type === 'json') {
    const txt = await fetchWithTimeout(src.url, 12000, 'application/json')
    const json = JSON.parse(txt)
    const hits = json.hits || []
    return hits.slice(0, 12).map((h) => ({
      title: h.title || h.story_title || '(无标题)',
      url: h.url || `https://news.ycombinator.com/item?id=${h.objectID}`,
      excerpt: stripTags(h.story_text || h.comment_text || '').slice(0, 320),
      publishedAt: h.created_at || null,
    }))
  }
  const xml = await fetchWithTimeout(src.url, 12000, 'application/rss+xml, application/xml, text/xml, */*')
  return parseRss(xml, 12)
}

/* ------------------------------------------------------------------ *
 *  AI 处理：由前端调用云服务 LLM 完成（此处只负责拼装给模型的输入）
 *  服务端不持有任何模型密钥。
 * ------------------------------------------------------------------ */

app.get('/api/sources', (_req, res) => {
  res.json({
    sources: SOURCES.map(({ id, name, category, type }) => ({ id, name, category, type })),
  })
})

/**
 * 每次送进 AI 处理的条数上限。
 * 实测云服务大模型生成一条摘要约 18-30 秒，且服务端对并发有限流，
 * 条数越多等待越久。默认 8 条是"信息够用"和"等得起"的平衡点。
 * 可用请求体里的 limit 覆盖（上限 24）。
 */
const DEFAULT_AI_LIMIT = 8
const MAX_AI_LIMIT = 24

/** 步骤 1+2：抓取。返回原始抓取结果，供前端展示"抓取到了什么" */
app.post('/api/fetch', async (req, res) => {
  const wanted = Array.isArray(req.body?.sourceIds) && req.body.sourceIds.length
    ? req.body.sourceIds
    : SOURCES.map((s) => s.id)

  const rawLimit = Number(req.body?.limit)
  const limit = Number.isFinite(rawLimit) && rawLimit > 0
    ? Math.min(Math.floor(rawLimit), MAX_AI_LIMIT)
    : DEFAULT_AI_LIMIT

  const targets = SOURCES.filter((s) => wanted.includes(s.id))
  const results = []
  const errors = []

  await Promise.all(
    targets.map(async (src) => {
      try {
        const items = await fetchSource(src)
        results.push({ source: { id: src.id, name: src.name, category: src.category }, items })
      } catch (e) {
        errors.push({ source: src.name, reason: e.message || '抓取失败' })
      }
    })
  )

  // 合并所有条目后做「配额均衡」再排序：
  // 单个源最多占 4 条，避免某个高频源（如 HN）把中文源全部挤掉，
  // 保证简报里中英文、不同领域都有代表。
  const PER_SOURCE_CAP = Math.max(2, Math.ceil(limit / 2))
  const taken = new Map()
  const flat = results
    .flatMap((r) => r.items.map((it) => ({ ...it, source: r.source.name, category: r.source.category })))
    .sort((a, b) => String(b.publishedAt || '').localeCompare(String(a.publishedAt || '')))
    .filter((it) => {
      const n = taken.get(it.source) || 0
      if (n >= PER_SOURCE_CAP) return false
      taken.set(it.source, n + 1)
      return true
    })
    .slice(0, limit)

  res.json({
    fetchedAt: new Date().toISOString(),
    totalRaw: results.reduce((n, r) => n + r.items.length, 0),
    processingLimit: limit,
    items: flat,
    errors,
  })
})

/**
 * 内容分类体系。
 * 前端会用这套标签让大模型给每条资讯打标，服务端负责校验与统计——
 * 统计放在服务端做，是因为"哪类多、哪类少"必须是算出来的，不能靠模型自己数。
 */
const TAGS = [
  { id: 'tool', name: '工具类', desc: 'AI工具、产品、开源项目的发布更新，或协议/接口/能力的新变化，侧重"能拿来用的东西"', color: '#185FA5' },
  { id: 'opinion', name: '观点类', desc: '行业评论、趋势判断、从业者观点、方法论分享与经验复盘，侧重"怎么看/怎么做"', color: '#993C1D' },
  { id: 'funding', name: '融资/商业', desc: '融资、并购、营收、定价、商业模式或厂商商业动作', color: '#3B6D11' },
  { id: 'research', name: '技术/研究', desc: '论文、模型能力评测、训练/算法等技术成果与突破', color: '#534AB7' },
  { id: 'other', name: '其他', desc: '与前四类都明显无关的资讯（如纯时政、社会新闻）', color: '#5F5E5A' },
]

app.get('/api/tags', (_req, res) => res.json({ tags: TAGS }))

/**
 * 分析报告生成：把「已打标的条目」整理成一份可下载的运营分析报告。
 *
 * 关键设计：**统计一律由服务端计算**，不采信模型给的比例。
 * 模型只负责给每条打标签和写一句话理由，聚合与占比必须可复算——
 * 否则这份报告里的数字就没法在面试时自证。
 */
app.post('/api/report', (req, res) => {
  const { items = [], generatedAt, sourceStats = [], reportNote = '' } = req.body || {}

  const total = items.length
  const tagMap = new Map(TAGS.map((t) => [t.id, t]))

  // —— 统计：按标签分组 ——
  const byTag = new Map()
  for (const t of TAGS) byTag.set(t.id, [])
  for (const it of items) {
    const key = tagMap.has(it.tag) ? it.tag : 'other'
    byTag.get(key).push(it)
  }

  // —— 统计：按来源分组 ——
  const bySource = new Map()
  for (const it of items) {
    const k = it.source || '未知来源'
    if (!bySource.has(k)) bySource.set(k, { count: 0, tags: new Map() })
    const s = bySource.get(k)
    s.count++
    s.tags.set(it.tag || 'other', (s.tags.get(it.tag || 'other') || 0) + 1)
  }

  const pct = (n) => (total ? ((n / total) * 100).toFixed(1) : '0.0')

  const lines = []
  lines.push('# AI 资讯结构分析报告')
  lines.push('')
  lines.push(`> 生成时间：${generatedAt || new Date().toISOString()}`)
  lines.push(`> 样本量：${total} 条　|　覆盖来源：${bySource.size} 个`)
  lines.push('> 由 AutoFlow「抓取 → AI 处理 → 分类 → 分析」流水线产出')
  lines.push('')
  lines.push('## 一、核心结论')
  lines.push('')

  const ranked = TAGS
    .map((t) => ({ tag: t, items: byTag.get(t.id) || [] }))
    .filter((x) => x.items.length > 0)
    .sort((a, b) => b.items.length - a.items.length)

  if (ranked.length) {
    const top = ranked[0]
    // 结论优先用前端算好的那句话（它包含"所以这意味着什么"的判断）；
    // 只有前端没传时才退回一句干巴巴的统计描述，避免两句话叠在一起重复说一遍。
    if (reportNote) {
      lines.push(reportNote)
    } else {
      lines.push(
        `本次样本中占比最高的是 **${top.tag.name}**，共 ${top.items.length} 条（${pct(top.items.length)}%）。` +
          (ranked[1]
            ? `其次是 ${ranked[1].tag.name} ${ranked[1].items.length} 条（${pct(ranked[1].items.length)}%）。`
            : '')
      )
    }
    lines.push('')
  } else {
    lines.push('（本次没有可统计的条目）')
    lines.push('')
  }

  lines.push('## 二、内容结构分布')
  lines.push('')
  lines.push('| 类别 | 条数 | 占比 | 说明 |')
  lines.push('| --- | ---: | ---: | --- |')
  for (const t of TAGS) {
    const n = (byTag.get(t.id) || []).length
    if (!n) continue
    lines.push(`| ${t.name} | ${n} | ${pct(n)}% | ${t.desc} |`)
  }
  lines.push('')

  lines.push('## 三、来源分布')
  lines.push('')
  lines.push('| 来源 | 抓取条数 | 主要类别 |')
  lines.push('| --- | ---: | --- |')
  for (const [name, s] of [...bySource.entries()].sort((a, b) => b[1].count - a[1].count)) {
    const main = [...s.tags.entries()].sort((a, b) => b[1] - a[1])[0]
    const mainName = tagMap.get(main?.[0])?.name || '其他'
    lines.push(`| ${name} | ${s.count} | ${mainName}${main ? `（${main[1]} 条）` : ''} |`)
  }
  lines.push('')

  lines.push('## 四、分条明细')
  lines.push('')
  for (const { tag, items: list } of ranked) {
    lines.push(`### ${tag.name}　${list.length} 条 / ${pct(list.length)}%`)
    lines.push('')
    list.forEach((it, i) => {
      lines.push(`${i + 1}. **${it.title || '(无标题)'}**`)
      if (it.source) lines.push(`   - 来源：${it.source}${it.publishedAt ? ` · ${String(it.publishedAt).slice(0, 10)}` : ''}`)
      if (it.summary) lines.push(`   - 摘要：${it.summary}`)
      if (it.tagReason) lines.push(`   - 归类理由：${it.tagReason}`)
      if (it.url) lines.push(`   - 链接：${it.url}`)
      lines.push('')
    })
  }

  res.setHeader('Content-Type', 'text/markdown; charset=utf-8')
  res.setHeader(
    'Content-Disposition',
    `attachment; filename="ai-analysis-${(generatedAt || '').slice(0, 10) || 'export'}.md"`
  )
  res.send(lines.join('\n'))
})

/** 归档：把 AI 处理结果整理成可下载的 Markdown */
app.post('/api/archive', (req, res) => {
  const { items = [], generatedAt, actionItems = [] } = req.body || {}
  const lines = []
  lines.push('# AI 资讯简报 · 自动归档')
  lines.push('')
  lines.push(`> 生成时间：${generatedAt || new Date().toISOString()}`)
  lines.push(`> 由 AutoFlow「抓取 → AI 处理与分类 → 归档」流水线产出`)
  lines.push('')

  // 章节编号按实际有没有"行动要点"来定，避免出现只有"二、"没有"一、"的断档
  const CN = ['一', '二', '三', '四', '五']
  let section = 0
  if (actionItems.length) {
    section++
    lines.push(`## ${CN[section - 1]}、值得行动的要点`)
    lines.push('')
    actionItems.forEach((a, i) => lines.push(`${i + 1}. ${a}`))
    lines.push('')
  }

  section++
  lines.push(`## ${CN[section - 1]}、分条摘要`)
  lines.push('')
  items.forEach((it, i) => {
    lines.push(`### ${i + 1}. ${it.title || '(无标题)'}`)
    lines.push('')
    if (it.tag) {
      const t = TAGS.find((x) => x.id === it.tag)
      if (t) lines.push(`- 类别：${t.name}${it.tagReason ? `（${it.tagReason}）` : ''}`)
    }
    if (it.source) lines.push(`- 来源：${it.source}${it.category ? ` / ${it.category}` : ''}`)
    if (it.publishedAt) lines.push(`- 时间：${it.publishedAt}`)
    if (it.url) lines.push(`- 链接：${it.url}`)
    if (it.summary) {
      lines.push('')
      lines.push(it.summary)
    }
    lines.push('')
  })

  res.setHeader('Content-Type', 'text/markdown; charset=utf-8')
  res.setHeader(
    'Content-Disposition',
    `attachment; filename="ai-brief-${(generatedAt || '').slice(0, 10) || 'export'}.md"`
  )
  res.send(lines.join('\n'))
})

app.get('/api/health', (_req, res) => res.json({ ok: true, time: new Date().toISOString() }))

/**
 * 合并托管：同一个链接下同时提供两个东西。
 *   /            → 黄鑫浩的个人作品集（静态主页）
 *   /autoflow/   → AutoFlow 自动化工作流界面（本服务的功能页）
 * 这样作品集和 AutoFlow 不必争抢同一个发布沙箱，一个 URL 两者都在。
 */
app.use(express.static(path.join(__dirname, 'public')))

app.listen(PORT, '0.0.0.0', () => {
  console.log(`AutoFlow + Portfolio listening on http://0.0.0.0:${PORT}`)
})
