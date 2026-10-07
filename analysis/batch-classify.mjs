/**
 * 批量打标脚本（一次性）：抓 60 条真实资讯 → 模型逐条分类 → 落盘
 *
 * 为什么要单独写这个而不是直接用页面：
 *  1) 页面并发 3，60 条要跑很久且可能触发限流；这里用「断点续跑」——
 *     每完成一条就写盘，中断了重跑会自动跳过已完成的，不用从头再来。
 *  2) 落盘的原始数据可以反复用来调可视化，不用重复烧模型调用。
 *
 * 用法：node batch-classify.mjs [目标条数]
 */
import { createWorkBuddyCloud } from '@tencent-ai/workbuddy-cloud-sdk'
import fs from 'node:fs'

const TARGET = Number(process.argv[2]) || 60

const ENDPOINT = 'https://huangxinhao-portfolio.app.workbuddy.host'
const RELAY = 'https://www.workbuddy.cn/v2/as/genie-baas/oauth'
const KEY = 'wbpk_SEFzfAoWFz2qQkY9jv6RnY_7COV5Hoox6dwHuhBOC0LZc3t5YmRGciN'

const SOURCES = [
  { id: 'infoq-ai', name: 'InfoQ·AI', category: '行业资讯', type: 'rss', url: 'https://www.infoq.cn/feed' },
  { id: 'ifanr', name: '爱范儿', category: '科技/消费', type: 'rss', url: 'https://www.ifanr.com/feed' },
  { id: 'geekpark', name: '极客公园', category: '科技/创投', type: 'rss', url: 'https://www.geekpark.net/rss' },
  { id: 'sspai', name: '少数派', category: '效率工具', type: 'rss', url: 'https://sspai.com/feed' },
  { id: 'hn', name: 'Hacker News', category: '技术社区', type: 'json', url: 'https://hn.algolia.com/api/v1/search_by_date?tags=story&hitsPerPage=60' },
]

const TAGS = [
  { id: 'tool', name: '工具类' },
  { id: 'opinion', name: '观点类' },
  { id: 'funding', name: '融资/商业' },
  { id: 'research', name: '技术/研究' },
  { id: 'other', name: '其他' },
]
const TAG_BY_ID = new Map(TAGS.map((t) => [t.id, t]))

const TAG_GUIDE =
  '你可选的内容类别如下：\n' +
  '- tool 工具类：AI 工具、产品、开源项目的发布或更新，或协议/接口/能力的新变化，侧重"能拿来用的东西"\n' +
  '- opinion 观点类：行业评论、趋势判断、从业者观点、方法论分享与经验复盘，侧重"怎么看/怎么做这件事"\n' +
  '- funding 融资/商业：融资、并购、营收、定价、商业模式或厂商商业动作\n' +
  '- research 技术/研究：论文、模型能力评测、训练/算法等技术成果与突破\n' +
  '- other 其他：确实无法归入以上各类的资讯\n' +
  '注意：宁可归入前四类中"最接近"的一个，也不要轻易用 other；' +
  '只有当这条内容与前四类都明显无关（如纯时政、社会新闻）时才选 other。'

const SYS =
  '你是一名资深的 AI 与互联网行业分析师。你的任务是把抓取的资讯逐条转述为简洁准确的中文要点。' +
  '严格要求：只依据原文信息，不要编造事实、数字或结论；若原文信息不足，就只概括已知内容。每条摘要不超过 80 字。'

/* ---------------- 抓取（与 server.js 同一套解析逻辑） ---------------- */
function decodeEntities(s = '') {
  return s.replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1')
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'").replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&')
}
function stripTags(s = '') {
  return decodeEntities(s).replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ').replace(/<[^>]+>/g, ' ')
    .replace(/\s+/g, ' ').trim()
}
function pick(block, tag) {
  const m = block.match(new RegExp(`<${tag}[^>]*>([\\s\\S]*?)<\\/${tag}>`, 'i'))
  return m ? decodeEntities(m[1]).trim() : ''
}
function parseRss(xml, limit) {
  const out = []
  const chunks = xml.match(/<(item|entry)[\s>][\s\S]*?<\/(item|entry)>/gi) || []
  for (const raw of chunks.slice(0, limit)) {
    const title = stripTags(pick(raw, 'title'))
    let link = pick(raw, 'link')
    if (!link) { const m = raw.match(/<link[^>]*href=["']([^"']+)["']/i); if (m) link = m[1] }
    const desc = pick(raw, 'description') || pick(raw, 'summary') || pick(raw, 'content:encoded') || pick(raw, 'content')
    const date = pick(raw, 'pubDate') || pick(raw, 'published') || pick(raw, 'updated')
    if (title && link) {
      out.push({ title, url: link.trim(), excerpt: stripTags(desc).slice(0, 400), publishedAt: date || null })
    }
  }
  return out
}
async function fetchOne(src) {
  const r = await fetch(src.url, { headers: { 'user-agent': 'Mozilla/5.0 AutoFlow/1.0', 'accept-language': 'zh-CN,zh;q=0.9' } })
  if (!r.ok) throw new Error('HTTP ' + r.status)
  if (src.type === 'json') {
    const j = await r.json()
    return (j.hits || []).map((h) => ({
      title: h.title || h.story_title || '(无标题)',
      url: h.url || `https://news.ycombinator.com/item?id=${h.objectID}`,
      excerpt: stripTags(h.story_text || h.comment_text || '').slice(0, 400),
      publishedAt: h.created_at || null,
    }))
  }
  return parseRss(await r.text(), 40)
}

/* ---------------- 模型调用 ---------------- */
async function chat(cloud, model, prompt) {
  let out = ''
  for await (const chunk of cloud.llm.chat.completions.create({
    model,
    messages: [{ role: 'system', content: SYS }, { role: 'user', content: prompt }],
    stream: true,
  })) {
    const d = chunk.choices?.[0]?.delta
    if (d?.content) out += d.content
  }
  return out.trim()
}

async function classify(cloud, model, item) {
  const raw0 = await chat(cloud, model,
    `请把下面这条资讯归入一个最合适的类别。\n${TAG_GUIDE}\n` +
    `只输出一行，格式严格为：类别ID|归类理由（理由不超过 30 字）。不要输出任何其他内容。\n\n` +
    `标题：${item.title}\n来源：${item.source}\n摘要：${item.excerpt || '（无）'}`)
  const raw = raw0.replace(/^[`"'\s]+|[`"'\s]+$/g, '')
  const m = raw.match(/^([a-zA-Z]+)\s*[|｜:：]\s*(.*)$/)
  let id = m ? m[1].toLowerCase() : ''
  let reason = m ? m[2].trim() : ''
  let fallback = false
  if (!TAG_BY_ID.has(id)) {
    const cn = raw.match(/(工具类|观点类|融资|技术|其他)/)
    const found = cn ? TAGS.find((t) => t.name.includes(cn[1]) || cn[1].includes(t.name.slice(0, 2))) : null
    id = found ? found.id : 'other'
    reason = reason || raw.slice(0, 30)
    fallback = true
  }
  return { tag: id, tagReason: reason.slice(0, 40), fallback }
}

/* ---------------- 主流程（断点续跑） ---------------- */
const OUT = 'analysis-data.json'
let saved = { items: [], doneKeys: [], startedAt: new Date().toISOString() }
if (fs.existsSync(OUT)) {
  try {
    saved = JSON.parse(fs.readFileSync(OUT, 'utf8'))
    console.log(`↻ 读取已有进度：已完成 ${saved.doneKeys.length} 条`)
  } catch { console.log('已有文件损坏，重新开始') }
}
const doneKeys = new Set(saved.doneKeys)

// 1. 抓取
console.log('\n【抓取】')
const all = []
for (const s of SOURCES) {
  try {
    const items = await fetchOne(s)
    all.push(...items.map((it) => ({ ...it, source: s.name, sourceId: s.id, category: s.category })))
    console.log(`  ${s.name.padEnd(12)} ${String(items.length).padStart(3)} 条`)
  } catch (e) {
    console.log(`  ${s.name.padEnd(12)} 失败: ${e.message}`)
  }
}

// 2. 配额均衡后取 TARGET 条（保证各源都有代表）
const PER = Math.max(2, Math.ceil(TARGET / SOURCES.length))
const taken = new Map()
const picked = all
  .sort((a, b) => String(b.publishedAt || '').localeCompare(String(a.publishedAt || '')))
  .filter((it) => {
    const n = taken.get(it.sourceId) || 0
    if (n >= PER) return false
    taken.set(it.sourceId, n + 1)
    return true
  })
  .slice(0, TARGET)

console.log(`\n【待处理】${picked.length} 条（各源上限 ${PER}）`)

// 已有结果的按 url 对齐
const prevByUrl = new Map(saved.items.map((it) => [it.url, it]))
const todo = picked.filter((it) => !doneKeys.has(it.url))
console.log(`【本轮需跑】${todo.length} 条（已跳过 ${picked.length - todo.length} 条）\n`)

const cloud = createWorkBuddyCloud({ endpoint: ENDPOINT, oauthRelayBaseUrl: RELAY, publishableKey: KEY })
const models = await cloud.llm.models.list()
const PRIORITY = ['glm-5.3-flash', 'glm-5.2-flash', 'hy3', 'glm-5.3']
let model = null
for (const w of PRIORITY) { const h = (models || []).find((m) => m.id === w && m.disabled !== true); if (h) { model = h.id; break } }
if (!model) model = ((models || []).find((m) => m.id !== 'auto') || models?.[0])?.id
console.log(`模型：${model}\n`)

const t0 = Date.now()
for (let i = 0; i < todo.length; i++) {
  const it = todo[i]
  const ts = ((Date.now() - t0) / 1000).toFixed(0)
  try {
    const c = await classify(cloud, model, it)
    const rec = { ...it, ...c, classifiedAt: new Date().toISOString() }
    saved.items = saved.items.filter((x) => x.url !== it.url).concat(rec)
    doneKeys.add(it.url)
    saved.doneKeys = [...doneKeys]
    fs.writeFileSync(OUT, JSON.stringify(saved, null, 2))
    console.log(`[${ts}s] ${(i + 1)}/${todo.length}  ${TAG_BY_ID.get(c.tag).name.padEnd(6)} ${c.tagReason}${c.fallback ? ' ←兜底' : ''}`)
  } catch (e) {
    console.log(`[${ts}s] ${(i + 1)}/${todo.length}  失败: ${e.message}`)
  }
}

// 3. 把已完成的补进最终结果（含之前跑过的）
const finalItems = picked.map((it) => prevByUrl.get(it.url) || saved.items.find((x) => x.url === it.url)).filter(Boolean)
saved.items = finalItems
saved.finishedAt = new Date().toISOString()
fs.writeFileSync(OUT, JSON.stringify(saved, null, 2))

console.log(`\n【完成】累计 ${finalItems.length} 条 → ${OUT}`)
const byTag = new Map()
for (const it of finalItems) byTag.set(it.tag, (byTag.get(it.tag) || 0) + 1)
for (const [k, n] of [...byTag.entries()].sort((a, b) => b[1] - a[1])) {
  console.log(`  ${TAG_BY_ID.get(k)?.name}: ${n} 条 (${((n / finalItems.length) * 100).toFixed(1)}%)`)
}
