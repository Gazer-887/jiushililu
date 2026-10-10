// 隔离IPC夹具喂给真实渲染组件；会话读数与全库比例各验来源、零值和未知。
module.exports = async function verifyM02Evidence({ win, setStats, setEntries, setConversations, checkTrue, shots }) {
  const { BrowserWindow } = require('electron')
  const { writeFileSync } = require('node:fs')
  const { join } = require('node:path')
  const pause = () => new Promise((r) => setTimeout(r, 450))
  const broadcast = (channel) => {
    for (const w of BrowserWindow.getAllWindows()) if (!w.isDestroyed()) w.webContents.send(channel)
  }
  const usage = (input, output) => ({ promptTokens: input, completionTokens: output, cachedPromptTokens: null, reasoningTokens: null })
  const records = [
    { id: 'm02-nonzero', title: '补证-非零', usage: usage(1000, 200), usageReported: true, reflectionUsage: usage(250, 50) },
    { id: 'm02-zero', title: '补证-零', usage: usage(0, 0), usageReported: true, reflectionUsage: usage(0, 0) },
    { id: 'm02-unknown', title: '补证-未知', usageReported: false }
  ].map((r) => ({ ...r, workspace: 'D:\\jsllworkplace_for_test', model: 'deepseek-flash', skills: [], createdAt: 1, updatedAt: 1, messageCount: 0, messages: [] }))
  const stats = (survivalRate, usageRate) => ({ survivalRate, usageRate, written: survivalRate === null ? 0 : 5,
    alive: survivalRate === 0.8 ? 4 : 0, recalled: usageRate === 0.3 ? 1 : 0,
    correctedCount: 0, repeatCorrectedCount: 0, flaggedCount: 0, repeatCorrectionRate: null, falsePositiveRate: null })
  const visible = (el) => {
    if (!el) return null
    const r = el.getBoundingClientRect(), style = getComputedStyle(el)
    return { text: el.textContent.trim(), w: r.width, h: r.height, visible: r.width > 0 && r.height > 0 && r.left >= 0 && r.right <= innerWidth && r.top >= 0 && r.bottom <= innerHeight && style.display !== 'none' && style.visibility !== 'hidden' }
  }
  const probeChip = () => win.webContents.executeJavaScript(`(() => {
    const visible = ${visible.toString()}; const chip=document.querySelector('.usage-chip');
    return { chat:visible(chip?.querySelector('.usage-total')), reflection:visible(chip?.querySelector('.usage-reflection')), title:chip?.title||'' };
  })()`)
  const select = async (title) => {
    const found = await win.webContents.executeJavaScript(`(() => {
      const el=Array.from(document.querySelectorAll('.conv-item')).find(x=>x.textContent.includes(${JSON.stringify(title)}));
      el?.click(); return !!el;
    })()`)
    if (!found) throw new Error(`会话夹具入口不可见：${title}`)
    await pause()
  }
  const beforeEntries = setEntries(null)
  try {
    setStats(stats(0.8, 0.3)); setConversations(records)
    broadcast('conv:changed'); broadcast('memory:changed'); await pause()
    await select('补证-非零')
    const nonzero = await probeChip()
    checkTrue('M02补证：对话1200与反思300分列且几何可见，反思不并入对话合计',
      nonzero.chat?.text === '1.2k' && nonzero.reflection?.text === '反思 300' && nonzero.chat.visible && nonzero.reflection.visible && nonzero.title.includes('主对话已上报合计：1200 tokens') && nonzero.title.includes('反思用量（切换会话时调用）：300 tokens'), nonzero)
    await select('补证-零')
    const zero = await probeChip()
    checkTrue('M02补证：已报告的对话0和反思0各自可见', zero.chat?.text === '0' && zero.reflection?.text === '反思 0' && zero.chat.visible && zero.reflection.visible, zero)
    await select('补证-未知')
    const unknown = await probeChip()
    checkTrue('M02补证：来源未知且无反思报告不冒充0用量', unknown.chat === null && unknown.reflection === null, unknown)
    await select('补证-非零')
    records[0].reflectionUsage = usage(500, 100)
    setConversations(records); broadcast('conv:changed'); await pause()
    const refreshed = await probeChip()
    checkTrue('M02补证：会话广播重读反思600，对话仍1200，切换不串账', refreshed.chat?.text === '1.2k' && refreshed.reflection?.text === '反思 600' && refreshed.reflection.visible, refreshed)

    setEntries([{ name: '补证记忆', description: '隔离条目', class: 'default', origin: 'user', body: '合成正文', file: '/mem/notes/m02-evidence.md', createdAt: '2026-10-01', updatedAt: '2026-10-01' }])
    broadcast('memory:changed'); await pause()
    for (let i = 0; i < 8; i++) {
      if (await win.webContents.executeJavaScript(`!!document.querySelector('.mem-stat')`)) break
      await win.webContents.executeJavaScript(`(() => {
        const tab=Array.from(document.querySelectorAll('.pane-tab')).find(x=>x.textContent.includes('记忆'));
        const toggle=Array.from(document.querySelectorAll('button')).find(x=>(x.title||'').includes('工作台'));
        (tab || document.querySelector('.pane-add') || toggle)?.click();
      })()`)
      await pause()
      await win.webContents.executeJavaScript(`Array.from(document.querySelectorAll('.wb-pick')).find(x=>x.textContent.includes('记忆'))?.click()`)
      await pause()
    }
    const probeStats = () => win.webContents.executeJavaScript(`(() => { const visible=${visible.toString()};return visible(document.querySelector('.mem-stat')); })()`)
    const positive = await probeStats()
    checkTrue('M02补证：主工作台记忆页存活80%与使用30%来自stats且几何可见', positive?.text.includes('存活 80%') && positive.text.includes('使用 30%') && positive.visible, positive)
    setStats(stats(0, 0)); broadcast('memory:changed'); await pause()
    const zeroStats = await probeStats()
    checkTrue('M02补证：有样本的存活0%与使用0%刷新后可见', zeroStats?.text.includes('存活 0%') && zeroStats.text.includes('使用 0%') && zeroStats.visible, zeroStats)
    setStats(stats(null, null)); broadcast('memory:changed'); await pause()
    const unknownStats = await probeStats()
    checkTrue('M02补证：无有效样本的比例保持未知，不显示存活0%或使用0%', unknownStats?.visible && !unknownStats.text.includes('存活') && !unknownStats.text.includes('使用'), unknownStats)
    setStats(stats(0.8, 0.3)); broadcast('memory:changed'); await pause()
    const restored = await probeStats()
    checkTrue('M02补证：记忆广播刷新恢复80%/30%，非初次挂载常量', restored?.text.includes('存活 80%') && restored.text.includes('使用 30%') && restored.visible, restored)
    await win.webContents.executeJavaScript(`new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))`)
    await pause()
    writeFileSync(join(shots, 'verify-m02-evidence-stats.png'), (await win.webContents.capturePage()).toPNG())
    setEntries([]); setStats(stats(null, null)); broadcast('memory:changed'); await pause()
    const empty = await probeStats()
    checkTrue('M02补证：空库不呈现带分母假比例', empty === null, empty)
    writeFileSync(join(shots, 'verify-m02-evidence-probes.json'), JSON.stringify({ nonzero, zero, unknown, refreshed, positive, zeroStats, unknownStats, restored, empty }, null, 2))
  } finally {
    setEntries(beforeEntries); setConversations(null); setStats(stats(0.8, 0.3))
    broadcast('conv:changed'); broadcast('memory:changed'); await pause()
  }
}
