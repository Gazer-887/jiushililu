// M02两处界面缺陷的真渲染回归。夹具经IPC重读，既验内容也量控件几何。
module.exports = async function verifyM02Ui({ win, openSettings, setStats, setPlaybooks, checkTrue, shots }) {
  const { BrowserWindow } = require('electron')
  const { writeFileSync } = require('node:fs')
  const { join } = require('node:path')
  const pause = () => new Promise((r) => setTimeout(r, 350))
  const broadcast = (channel) => {
    for (const w of BrowserWindow.getAllWindows()) if (!w.isDestroyed()) w.webContents.send(channel)
  }
  const stat = (rate) => ({ survivalRate: 0.8, usageRate: 0.3, written: 5, alive: 4, recalled: 1,
    correctedCount: rate === null ? 0 : 2, repeatCorrectedCount: rate === 0.5 ? 1 : 0,
    flaggedCount: 1, repeatCorrectionRate: rate, falsePositiveRate: 0.2,
    correctionByVersion: [
      { appVersion: '0.13.104', statsVersion: 1, correctedCount: 2, repeatCorrectedCount: 1, repeatCorrectionRate: 0.5 },
      { appVersion: null, statsVersion: null, correctedCount: 1, repeatCorrectedCount: 0, repeatCorrectionRate: 0 }
    ] })
  const readChip = () => win.webContents.executeJavaScript(`(() => {
    const el=document.querySelector('.usage-repeat-correction'); if(!el)return null;
    const r=el.getBoundingClientRect();return {text:el.textContent.trim(),title:el.closest('.usage-chip').title,w:r.width,h:r.height,right:r.right,viewport:innerWidth};
  })()`)
  setStats(stat(0.5)); broadcast('memory:changed'); await pause()
  const half = await readChip()
  checkTrue('M02 B4-D2：未打开记忆页签也能重读用量牌重复纠正率50%，且几何可见',
    half?.text === '重复纠正 50%' && half.w > 0 && half.h > 0 && half.right <= half.viewport && half.title.includes('全库累计'), half)
  setStats(stat(null)); broadcast('memory:changed'); await pause()
  checkTrue('M02 B4-D2：无纠正样本不显示比例', (await readChip()) === null)
  setStats(stat(0)); broadcast('memory:changed'); await pause()
  checkTrue('M02 B4-D2：有样本的零重复明确显示0%', (await readChip())?.text === '重复纠正 0%')

  await openSettings()
  const settings = BrowserWindow.getAllWindows().find((w) => w !== win && !w.isDestroyed())
  const before = setPlaybooks(null)
  setPlaybooks(before.concat([{ ...before[0], name: 'debug-case', tags: ['debug'], file: '/evo/playbooks/debug-case.md' }]))
  broadcast('playbook:changed')
  await settings.webContents.executeJavaScript(`Array.from(document.querySelectorAll('.settings-nav-item')).find(x=>x.textContent.trim()==='Playbook')?.click()`)
  await pause()
  const readPanel = () => settings.webContents.executeJavaScript(`(() => {
    const p=Array.from(document.querySelectorAll('.mem-panel')).find(x=>x.querySelector('.mem-title')?.textContent==='Playbook');
    const select=p?.querySelector('.pb-tag-filter');const r=select?.getBoundingClientRect();
    return {names:Array.from(p?.querySelectorAll('.mem-row .mem-name')||[]).map(x=>x.textContent.trim()),empty:p?.querySelector('.pb-filter-empty')?.textContent,
      options:Array.from(select?.options||[]).map(x=>x.value),w:r?.width,h:r?.height,right:r?.right,viewport:innerWidth};
  })()`)
  const all = await readPanel()
  checkTrue('M02 B3-D4：标签筛选控件可见且含两种任务标签', all.options.includes('file-edit') && all.options.includes('debug') && all.w > 0 && all.h >= 28 && all.right <= all.viewport, all)
  await settings.webContents.executeJavaScript(`(() => { const s=document.querySelector('.pb-tag-filter');if(s){s.value='debug';s.dispatchEvent(new Event('change',{bubbles:true}));} })()`)
  await pause()
  const debug = await readPanel()
  checkTrue('M02 B3-D4：debug标签只显示debug条目', debug.names.length === 1 && debug.names[0] === 'debug-case', debug)
  await settings.webContents.executeJavaScript(`(() => { const s=document.querySelector('.pb-tag-filter');if(s){s.value='';s.dispatchEvent(new Event('change',{bubbles:true}));} })()`)
  await pause()
  checkTrue('M02 B3-D4：全部标签恢复两个条目', (await readPanel()).names.length === 2)

  setStats(stat(0.5)); broadcast('memory:changed'); await pause()
  // 版本统计在主工作台记忆页签；设置的记忆页只管理开关。
  for (let i = 0; i < 8; i++) {
    if (await win.webContents.executeJavaScript(`!!document.querySelector('.mem-correction-versions')`)) break
    await win.webContents.executeJavaScript(`(() => {
      const add=document.querySelector('.pane-add');
      const toggle=Array.from(document.querySelectorAll('button')).find(b=>(b.title||'').includes('工作台'));
      (add || toggle)?.click();
    })()`)
    await pause()
    await win.webContents.executeJavaScript(`Array.from(document.querySelectorAll('.wb-pick')).find(b=>(b.textContent||'').includes('记忆'))?.click()`)
    await pause()
  }
  const versions = await win.webContents.executeJavaScript(`document.querySelector('.mem-correction-versions')?.textContent || ''`)
  checkTrue('M02 B4-D3：记忆页按版本显示样本数并披露旧记录不可逐版本比较', versions.includes('0.13.104') && versions.includes('1 / 2') && versions.includes('未标版本') && versions.includes('不可逐版本比较'), versions)
  await settings.webContents.executeJavaScript(`Array.from(document.querySelectorAll('.settings-nav-item')).find(x=>x.textContent.trim()==='Playbook')?.click()`)
  await pause()
  writeFileSync(join(shots, 'verify-m02-playbook-filter.png'), (await settings.webContents.capturePage()).toPNG())
  writeFileSync(join(shots, 'verify-m02-usage-repeat.png'), (await win.webContents.capturePage()).toPNG())
  setPlaybooks(before); setStats(stat(0.5)); broadcast('playbook:changed'); broadcast('memory:changed')
  await pause()
  if (!settings.isDestroyed()) settings.destroy()
}
