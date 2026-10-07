/**
 * 把 batch-classify.mjs 产出的 analysis-data.json
 * 转换成报告页用的 public/analysis/data.js
 *
 * 为什么中间加一层：报告页是纯静态的，不需要也不应该联网或调用模型。
 * 数据一次性算好、内联进页面，打开就能看，也方便直接放到线上任何地方。
 */
import fs from 'node:fs'
import path from 'node:path'

const SRC = 'analysis-data.json'
const OUT = path.join('..', 'public', 'analysis', 'data.js')

if (!fs.existsSync(SRC)) {
  console.error(`找不到 ${SRC}，请先运行 batch-classify.mjs`)
  process.exit(1)
}

const raw = JSON.parse(fs.readFileSync(SRC, 'utf8'))
const items = raw.items.filter((i) => i.tag && i.title)

const TAGS = [
  { id: 'tool', name: '工具类', color: '#185FA5', desc: 'AI 工具/产品/开源项目的发布与更新，或协议、接口、能力的新变化' },
  { id: 'opinion', name: '观点类', color: '#993C1D', desc: '行业评论、趋势判断、从业者观点、方法论分享与经验复盘' },
  { id: 'funding', name: '融资/商业', color: '#3B6D11', desc: '融资、并购、营收、定价、商业模式或厂商商业动作' },
  { id: 'research', name: '技术/研究', color: '#534AB7', desc: '论文、模型能力评测、训练/算法等技术成果与突破' },
  { id: 'other', name: '其他', color: '#5F5E5A', desc: '与前四类都明显无关的资讯（纯时政、社会新闻等）' },
]

const payload = {
  generatedAt: (raw.finishedAt || new Date().toISOString()).slice(0, 10).replace(/-/g, '.'),
  tags: TAGS,
  items: items.map((i) => ({
    title: i.title,
    url: i.url,
    source: i.source,
    sourceId: i.sourceId,
    tag: i.tag,
    tagReason: i.tagReason || '',
    publishedAt: i.publishedAt || null,
  })),
}

fs.mkdirSync(path.dirname(OUT), { recursive: true })
fs.writeFileSync(
  OUT,
  '/* 自动生成，请勿手改。源：analysis/analysis-data.json */\n' +
    'window.ANALYSIS = ' +
    JSON.stringify(payload, null, 2) +
    ';\n'
)

// 落盘同时打印一份统计，便于核验
const byTag = new Map()
for (const i of items) byTag.set(i.tag, (byTag.get(i.tag) || 0) + 1)
console.log(`写入 ${OUT}`)
console.log(`样本 ${items.length} 条 / 来源 ${new Set(items.map((i) => i.source)).size} 个`)
for (const t of TAGS) {
  const n = byTag.get(t.id) || 0
  const srcs = new Set(items.filter((i) => i.tag === t.id).map((i) => i.source)).size
  console.log(`  ${t.name.padEnd(6)} ${String(n).padStart(2)} 条 · ${((n / items.length) * 100).toFixed(1).padStart(5)}% · 覆盖 ${srcs} 源`)
}
