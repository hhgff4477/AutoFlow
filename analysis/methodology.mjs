/**
 * 分析口径定义 —— 这份报告"能得出什么结论、为什么"的全部依据。
 *
 * ⚠️ 核心约束：RSS 里没有阅读量/转发数，公开源也不提供。
 *    所以任何"哪类转发高"的说法都是编的，不能写。
 *
 * 我们改用一个**可算、可复算、不依赖平台后台**的口径：
 *
 *   指标 1｜结构占比（供给结构）
 *     某类条数 / 总条数。回答"行业当前主要在产什么"。
 *
 *   指标 2｜跨源覆盖度（这是替代"热度"的核心指标）
 *     有该类内容的源数 / 总源数。
 *     含义：一个话题如果被多个独立来源同时报道，说明它是行业内被持续追踪的；
 *     如果只有某一个源在写，说明它是该媒体的独家口味，不代表普适热度。
 *     ——这是在没有转发数据时，最接近"热度"的可算代理指标。
 *
 *   指标 3｜源内占比（防止被大源带偏）
 *     某类在某源内的占比。用于识别"某类内容集中在哪个源"，
 *     避免因为某个源条数多就把整体结构带歪。
 *
 * 结论怎么推（必须由数字驱动，不能写套话）：
 *   - 高占比 + 高覆盖度  → 是行业共识型内容，做它起点稳、但同质化竞争激烈
 *   - 高占比 + 低覆盖度  → 是某类源的偏好，不宜当作所有人都会看
 *   - 低占比 + 高覆盖度  → 是"大家都在提但没人深做"的空位 → 最值得切入
 *   - 低占比 + 低覆盖度  → 边缘内容，除非有独特视角否则不做
 */

export const TAGS = [
  { id: 'tool', name: '工具类', color: '#185FA5', desc: 'AI 工具/产品/开源项目的发布与更新，或协议、接口、能力的新变化' },
  { id: 'opinion', name: '观点类', color: '#993C1D', desc: '行业评论、趋势判断、从业者观点、方法论分享与经验复盘' },
  { id: 'funding', name: '融资/商业', color: '#3B6D11', desc: '融资、并购、营收、定价、商业模式或厂商商业动作' },
  { id: 'research', name: '技术/研究', color: '#534AB7', desc: '论文、模型能力评测、训练/算法等技术成果与突破' },
  { id: 'other', name: '其他', color: '#5F5E5A', desc: '与前四类都明显无关的资讯（纯时政、社会新闻等）' },
]

/**
 * 计算全部指标。输入 items 每条含 { tag, source, sourceId }。
 * 所有比例一律代码算，绝不采信模型输出。
 */
export function analyze(items) {
  const total = items.length
  const sources = [...new Set(items.map((i) => i.source))]
  const srcCount = sources.length

  const byTag = new Map()
  for (const t of TAGS) byTag.set(t.id, { id: t.id, name: t.name, color: t.color, desc: t.desc, n: 0, srcs: new Set(), bySrc: new Map() })

  for (const it of items) {
    const k = byTag.has(it.tag) ? it.tag : 'other'
    const rec = byTag.get(k)
    rec.n++
    rec.srcs.add(it.source)
    rec.bySrc.set(it.source, (rec.bySrc.get(it.source) || 0) + 1)
  }

  const rows = TAGS.map((t) => {
    const r = byTag.get(t.id)
    const share = total ? (r.n / total) * 100 : 0          // 指标1 结构占比
    const cover = srcCount ? (r.srcs.size / srcCount) * 100 : 0 // 指标2 跨源覆盖度
    return { ...r, srcs: [...r.srcs], share, cover }
  })

  // 源 × 类别 矩阵（指标3 的载体）
  const sourceRows = sources.map((s) => {
    const mine = items.filter((i) => i.source === s)
    const cells = TAGS.map((t) => ({
      tag: t.id, name: t.name, color: t.color,
      n: mine.filter((i) => (byTag.has(i.tag) ? i.tag : 'other') === t.id).length,
    }))
    return { source: s, total: mine.length, cells }
  }).sort((a, b) => b.total - a.total)

  return { total, srcCount, sources, rows, sourceRows }
}

/**
 * 四象限判断：把「占比」和「覆盖度」交叉，得出可执行建议。
 * 阈值取中位数而不是拍脑袋的固定值——样本变了，判断跟着变。
 */
export function quadrants(rows) {
  const active = rows.filter((r) => r.n > 0 && r.id !== 'other')
  if (!active.length) return []
  const midShare = [...active].sort((a, b) => a.share - b.share)[Math.floor(active.length / 2)].share
  const midCover = [...active].sort((a, b) => a.cover - b.cover)[Math.floor(active.length / 2)].cover

  return active.map((r) => {
    const hiS = r.share >= midShare
    const hiC = r.cover >= midCover
    let type, advice
    if (hiS && hiC) {
      type = '共识型'
      advice = '供给充足且被多源共同关注。做它观众基数大、但同质化最严重——必须叠加自己的实测或独特视角才能被记住。'
    } else if (hiS && !hiC) {
      type = '集中型'
      advice = '供给多但集中在少数源，说明是某类媒体的偏好口味，不代表普遍需求。作为切入方向要谨慎。'
    } else if (!hiS && hiC) {
      type = '空位型'
      advice = '大家都在提、但还没人深做。这是最值得切入的位置——竞争小、需求已被验证。'
    } else {
      type = '边缘型'
      advice = '供给与关注度都低。除非你有独特资源或视角，否则不建议作为主线。'
    }
    return { ...r, type, advice }
  }).sort((a, b) => b.share - a.share)
}

/** 综合出一个"该主打哪类"的结论（数字驱动） */
export function verdict(items, rows) {
  const q = quadrants(rows)
  const gap = q.filter((r) => r.type === '空位型')
  const consensus = q.filter((r) => r.type === '共识型')
  const top = [...rows].filter((r) => r.id !== 'other' && r.n > 0).sort((a, b) => b.share - a.share)[0]

  const lines = []
  if (top) {
    lines.push(
      `本样本共 ${items.length} 条，覆盖 ${new Set(items.map((i) => i.source)).size} 个来源。` +
      `其中 **${top.name}** 占比最高（${top.n} 条 · ${top.share.toFixed(0)}%），跨源覆盖度 ${top.cover.toFixed(0)}%。`
    )
  }
  if (gap.length) {
    lines.push(
      `更值得注意的是 **${gap.map((g) => g.name).join('、')}** 处于"空位型"——` +
      `多源都在报道（覆盖度 ${gap.map((g) => g.cover.toFixed(0) + '%').join('、')}），但占比偏低（${gap.map((g) => g.share.toFixed(0) + '%').join('、')}）。` +
      `需求已被验证、深度内容却稀缺，这是竞争最小的位置。`
    )
  }
  if (consensus.length) {
    lines.push(
      `而 **${consensus.map((c) => c.name).join('、')}** 属于"共识型"：供给与关注度都高，` +
      `说明受众基数最大，但也意味着搬运型内容最难出头。`
    )
  }
  return lines
}
