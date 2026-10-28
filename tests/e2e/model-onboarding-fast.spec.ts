// S3-V10 本包 UI 入口验证：模型接入（模板清单 / 事实区 / 用户覆盖）。
//
// 驱动真入口 `out/main/index.js` + 真 preload 桥 + 真 IPC + 真落盘；只有设置窗口是真界面被测物。
// 本文件不联网、不打真实供应商：模板选择零网络，事实与覆盖只读写本地 models.json。
// ⚠️ 元数据补丁的"真的走了通道"用**主进程真值回读**证明（observedAt 由主进程盖章），不靠界面自报。
// ⚠️ 未保存模型"不发补丁"用主进程侧计数 handler 证明（removeHandler + handle 是公开 API），
//    计数为 0 才是结论；只看界面上没有按钮属于弱断言，不能单独当证据。

import { expect, test, type Page } from '@playwright/test'
import { createServer, type Server } from 'node:http'
import { once } from 'node:events'
import type { AddressInfo } from 'node:net'
import { apiCall, launchApp, type E2EApp } from './helpers'

/** 种子时间戳：早于任何一次用户覆盖，用来区分"官方/目录层"与"本次盖章" */
const SEED_TS = 1758000000000
const PROFILE_NAME = 'S3-V10 元数据夹具'

interface ObsLike<T> {
  value: T
  observedAt: number
  limitations?: string[]
}
interface MetaValueLike<T> {
  official?: ObsLike<T>
  catalog?: ObsLike<T>
  user?: ObsLike<T>
}
type MetadataLike = Record<string, MetaValueLike<unknown> | undefined>

interface Rect {
  x: number
  y: number
  w: number
  h: number
}

interface FactsSnapshot {
  rows: Array<{ label: string; value: string; known: boolean; meta: string }>
  columns: Array<{ title: string; labels: string[]; text: string; rect: Rect }>
  priceGroups: Array<{ label: string; lines: string[]; unknown: string[] }>
  priceText: string
  override: { text: string; inputs: number; buttons: string[] } | null
  valuesOverflow: string[]
  fontSizes: number[]
  factsWidth: { scroll: number; client: number }
  bodyWidth: { scroll: number; client: number }
}

/** 打开设置独立窗口并按 URL 认身份（不用 firstWindow —— 见 helpers 的窗口身份纪律） */
async function openSettings(h: E2EApp): Promise<Page> {
  await apiCall(h.page, 'openSettingsWindow')
  const deadline = Date.now() + 30_000
  while (Date.now() < deadline) {
    const w = h.app.windows().find((x) => x.url().includes('settings'))
    if (w) {
      await w.waitForSelector('.settings-nav-item', { timeout: 20_000 })
      return w
    }
    await new Promise((r) => setTimeout(r, 250))
  }
  throw new Error('设置独立窗口没打开')
}

/** 进「模型」分区（按 data-nav 定位，不拿文案当坐标 —— 文案会随语言变） */
async function gotoModelSection(sw: Page): Promise<void> {
  await sw.locator('[data-nav="model"]').click()
  await sw.waitForSelector('.model-head', { timeout: 15_000 })
}

/** 点「添加模型」直到模板选择器出现（settings 初始值为空时首点会被 startCreate 的守卫吃掉） */
async function openPresetPicker(sw: Page): Promise<void> {
  await expect
    .poll(
      async () => {
        if (await sw.locator('.preset-picker').count()) return 'open'
        if (await sw.locator('.model-add').count()) await sw.locator('.model-add').click()
        return (await sw.locator('.preset-picker').count()) ? 'open' : 'wait'
      },
      { timeout: 20_000, message: '模板选择器没打开' }
    )
    .toBe('open')
}

/** 造一份**已保存**端点：两条模型 —— 一条全未知、一条带 official/catalog 两层元数据（含真实零价） */
async function seedProfile(h: E2EApp): Promise<{ profileId: string }> {
  const saved = await apiCall<{ id: string }>(h.page, 'saveModel', {
    name: PROFILE_NAME,
    providerType: 'openai-compatible',
    baseURL: 'https://api.example.com/v1',
    stream: true,
    timeoutMs: 15_000,
    models: [
      { id: 's3v10-unknown', model: 's3v10-unknown-model' },
      {
        id: 's3v10-known',
        model: 's3v10-known-model',
        metadata: {
          contextWindow: { official: { value: 100_000, observedAt: SEED_TS } },
          maxOutputTokens: { catalog: { value: 4096, observedAt: SEED_TS } },
          nativeExtendedInputs: { catalog: { value: ['audio', 'pdf'], observedAt: SEED_TS } },
          attachmentParsing: {
            catalog: { value: { supported: true, parsers: ['pdf-text'] }, observedAt: SEED_TS }
          },
          pricing: {
            catalog: {
              value: [
                { category: 'public-api', amount: 0, currency: 'USD', unit: '1M tokens', scope: 'input' }
              ],
              observedAt: SEED_TS
            }
          }
        }
      }
    ],
    apiKey: ''
  })
  expect(saved.id, '保存端点应回 id').toBeTruthy()
  return { profileId: saved.id }
}

/** 从列表进种子端点的编辑二级页 */
async function editSeededProfile(sw: Page): Promise<void> {
  const row = sw.locator('.model-row', { hasText: PROFILE_NAME })
  await expect(row, '种子端点应出现在模型列表').toHaveCount(1)
  await row.locator('[title="编辑该模型"]').click()
  await sw.waitForSelector('.settings-subpage .mc', { timeout: 15_000 })
}

/** 按模型 ID 展开某一行（单行展开：先收起当前行，等一帧再展开目标行） */
async function expandByModelId(sw: Page, modelId: string): Promise<void> {
  const rows = sw.locator('.mc-row')
  const n = await rows.count()
  for (let i = 0; i < n; i += 1) {
    if ((await rows.nth(i).locator('.mc-model').inputValue()) !== modelId) continue
    if (await sw.locator('.mc-row.on').count()) {
      await sw.locator('.mc-row.on .mc-icon:not(.mc-del)').click()
      await sw.waitForTimeout(150)
    }
    await rows.nth(i).locator('.mc-icon:not(.mc-del)').click()
    await expect(sw.locator('.mc-adv')).toHaveCount(1)
    return
  }
  throw new Error('找不到模型行：' + modelId)
}

async function readFacts(sw: Page): Promise<FactsSnapshot> {
  return sw.evaluate(() => {
    const rect = (el: Element): { x: number; y: number; w: number; h: number } => {
      const r = el.getBoundingClientRect()
      return { x: r.x, y: r.y, w: r.width, h: r.height }
    }
    const adv = document.querySelector('.mc-adv')
    if (!adv) throw new Error('高级面板没展开')
    const rows = Array.from(adv.querySelectorAll('.mc-fact')).map((r) => ({
      label: (r.querySelector('.mc-fact-label')?.textContent ?? '').trim(),
      value: (r.querySelector('.mc-fact-value')?.textContent ?? '').trim(),
      known: !(r.querySelector('.mc-fact-value')?.classList.contains('is-unknown') ?? false),
      meta: (r.querySelector('.mc-fact-meta')?.textContent ?? '').trim()
    }))
    const columns = Array.from(adv.querySelectorAll('.mc-facts-col')).map((c) => ({
      title: (c.querySelector('.mc-facts-col-title')?.textContent ?? '').trim(),
      labels: Array.from(c.querySelectorAll('.mc-fact-label')).map((l) => (l.textContent ?? '').trim()),
      text: (c.textContent ?? '').trim(),
      rect: rect(c)
    }))
    const blocks = Array.from(adv.querySelectorAll('.mc-facts-block'))
    const price = blocks.find(
      (b) => (b.querySelector('.mc-facts-col-title')?.textContent ?? '').trim() === '价格'
    )
    const priceGroups = price
      ? Array.from(price.querySelectorAll('.mc-price-group')).map((g) => ({
          label: (g.querySelector('.mc-price-cat')?.textContent ?? '').trim(),
          lines: Array.from(g.querySelectorAll('.mc-price-line')).map((l) => (l.textContent ?? '').trim()),
          unknown: Array.from(g.querySelectorAll('.mc-fact-value.is-unknown')).map((u) =>
            (u.textContent ?? '').trim()
          )
        }))
      : []
    const override = adv.querySelector('.mc-override')
    const facts = adv.querySelector('.mc-facts')
    const body = document.querySelector('.settings-body')
    return {
      rows,
      columns,
      priceGroups,
      priceText: price ? (price.textContent ?? '').trim() : '',
      override: override
        ? {
            text: (override.textContent ?? '').trim(),
            inputs: override.querySelectorAll('input').length,
            buttons: Array.from(override.querySelectorAll('button')).map((b) => (b.textContent ?? '').trim())
          }
        : null,
      valuesOverflow: Array.from(adv.querySelectorAll('.mc-fact-value, .mc-fact-meta'))
        .filter((el) => el.scrollWidth > el.clientWidth + 1)
        .map((el) => (el.textContent ?? '').trim()),
      fontSizes: Array.from(adv.querySelectorAll('.mc-fact-label, .mc-fact-value')).map((el) =>
        parseFloat(getComputedStyle(el).fontSize)
      ),
      factsWidth: facts
        ? { scroll: facts.scrollWidth, client: facts.clientWidth }
        : { scroll: 0, client: 0 },
      bodyWidth: body ? { scroll: body.scrollWidth, client: body.clientWidth } : { scroll: 0, client: 0 }
    }
  })
}

/** 两个矩形是否有真实重叠（留 1px 容差，避免亚像素抖动把相邻边判成重叠） */
function overlaps(a: Rect, b: Rect): boolean {
  const w = Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x)
  const h = Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y)
  return w > 1 && h > 1
}

test.describe('S3-V10 模型接入：真实渲染与入口', () => {
  test('模板清单：分类齐全、禁用项不可选、双协议面/认证/帮助链接、几何与键盘', async () => {
    const h = await launchApp()
    try {
      const sw = await openSettings(h)
      await gotoModelSection(sw)
      await openPresetPicker(sw)

      // ① 分类：四个可选类别 + 一个禁用类别，全部渲染成 fieldset 组
      const legends = (await sw.locator('.preset-picker fieldset.preset-group > legend').allTextContents()).map(
        (t) => t.trim()
      )
      expect(legends).toEqual(
        expect.arrayContaining(['普通 API / 聚合', '订阅', '自定义', '本地网关', '禁用（不可选择）'])
      )
      expect(await sw.locator('.preset-picker fieldset.preset-group').count(), '应有 5 个分类组').toBe(5)

      // ② 禁用项不可选：不是按钮、没有按钮后代、点了不关面板也不改草稿
      const forbidden = await sw.evaluate(() => {
        const items = Array.from(document.querySelectorAll('.preset-forbidden-item'))
        return items.map((el) => ({
          name: (el.querySelector('.preset-forbidden-name')?.textContent ?? '').trim(),
          reason: (el.querySelector('.preset-forbidden-reason')?.textContent ?? '').trim(),
          tag: el.tagName.toLowerCase(),
          role: el.getAttribute('role'),
          buttons: el.querySelectorAll('button').length,
          help: el.querySelector('.preset-help-link')?.getAttribute('href') ?? null
        }))
      })
      expect(forbidden, '禁用五项应全部列出').toHaveLength(5)
      for (const f of forbidden) {
        expect(f.tag, '禁用项整项不是按钮').not.toBe('button')
        expect(f.role, '禁用项不得伪装成按钮').not.toBe('button')
        expect(f.buttons, '禁用项内部不得有可选按钮').toBe(0)
        expect(f.reason.length, '官方禁用原因必须可见').toBeGreaterThan(0)
        expect(f.help, '禁用项应带官方依据链接').toMatch(/^https?:\/\//)
      }
      const forbiddenNames = forbidden.map((f) => f.name)
      const selectableNames = await sw.evaluate(() =>
        Array.from(document.querySelectorAll('.preset-btn, .preset-face-btn')).map((b) =>
          (b.textContent ?? '').trim()
        )
      )
      for (const name of forbiddenNames) {
        expect(selectableNames.some((t) => t.includes(name)), `禁用项 ${name} 不许出现在可选按钮里`).toBe(false)
      }
      const baseURLBefore = await sw
        .locator('.settings-subpage label', { hasText: '接口地址 baseURL' })
        .locator('input')
        .inputValue()
      await sw.locator('.preset-forbidden-item').first().click()
      await expect(sw.locator('.preset-picker'), '点禁用项不应关闭面板').toHaveCount(1)
      expect(
        await sw.locator('.settings-subpage label', { hasText: '接口地址 baseURL' }).locator('input').inputValue(),
        '点禁用项不应改动草稿'
      ).toBe(baseURLBefore)

      // ③ 双协议模板：DeepSeek 两个协议面 + 帮助链接（新窗口 + noreferrer noopener）
      const deepseek = sw.locator('.preset-dual', { hasText: 'DeepSeek' })
      await expect(deepseek, 'DeepSeek 应是双协议模板').toHaveCount(1)
      const faces = deepseek.locator('.preset-face-btn')
      await expect(faces, '双协议模板应给两个协议面按钮').toHaveCount(2)
      const help = deepseek.locator('.preset-help-link')
      await expect(help).toHaveCount(1)
      expect(await help.getAttribute('href')).toBe('https://api-docs.deepseek.com/')
      expect(await help.getAttribute('target')).toBe('_blank')
      expect((await help.getAttribute('rel')) ?? '').toContain('noreferrer')

      // ④ 控件可见 / 字体 / 几何：零尺寸、文字溢出、条目重叠一网打尽
      const geometry = await sw.evaluate(() => {
        const picker = document.querySelector('.preset-picker')
        if (!picker) throw new Error('模板选择器不在')
        const rect = (el: Element): { x: number; y: number; w: number; h: number } => {
          const r = el.getBoundingClientRect()
          return { x: r.x, y: r.y, w: r.width, h: r.height }
        }
        const items = Array.from(picker.querySelectorAll('.preset-item')).map(rect)
        const ctrls = Array.from(picker.querySelectorAll('.preset-btn, .preset-face-btn, .preset-help-link'))
        const body = document.querySelector('.settings-body')
        return {
          zeroSized: ctrls.filter((el) => {
            const r = el.getBoundingClientRect()
            return r.width <= 0 || r.height <= 0
          }).length,
          fontSizes: ctrls.map((el) => parseFloat(getComputedStyle(el).fontSize)),
          overflows: ctrls
            .filter((el) => el.scrollWidth > el.clientWidth + 1)
            .map((el) => (el.textContent ?? '').trim()),
          items,
          bodyWidth: body ? { scroll: body.scrollWidth, client: body.clientWidth } : { scroll: 0, client: 0 }
        }
      })
      expect(geometry.zeroSized, '模板控件不许零尺寸').toBe(0)
      expect(Math.min(...geometry.fontSizes), '模板控件字号不得小于 10.5px').toBeGreaterThanOrEqual(10.5)
      expect(geometry.overflows, '模板控件文字不许横向溢出').toEqual([])
      for (let i = 0; i < geometry.items.length; i += 1) {
        for (let j = i + 1; j < geometry.items.length; j += 1) {
          expect(
            overlaps(geometry.items[i], geometry.items[j]),
            `模板条目 ${i} 与 ${j} 几何重叠`
          ).toBe(false)
        }
      }
      expect(geometry.bodyWidth.scroll - geometry.bodyWidth.client, '设置内容区不许横向溢出').toBeLessThanOrEqual(2)

      // ⑤ 键盘可达 + 可激活：Tab 在对话框内移动，Enter 选中模板，空格切换认证
      await faces.filter({ hasText: 'OpenAI 兼容' }).focus()
      expect(
        await sw.evaluate(() => (document.activeElement?.className ?? '').toString()),
        '协议面按钮应可聚焦'
      ).toContain('preset-face-btn')
      await sw.keyboard.press('Tab')
      expect(
        await sw.evaluate(() => !!document.activeElement?.closest('.preset-picker')),
        'Tab 后焦点应仍在模板对话框内'
      ).toBe(true)
      await faces.filter({ hasText: 'OpenAI 兼容' }).focus()
      await sw.keyboard.press('Enter')
      await expect(sw.locator('.preset-picker'), 'Enter 应能选中协议面').toHaveCount(0)

      // ⑥ 选中 OpenAI 面：协议/地址/认证控件/帮助链接全部跟随
      await expect(sw.locator('.settings-subpage label', { hasText: '协议类型' }).locator('select')).toHaveValue(
        'openai-compatible'
      )
      await expect(
        sw.locator('.settings-subpage label', { hasText: '接口地址 baseURL' }).locator('input')
      ).toHaveValue('https://api.deepseek.com')
      const authOpenAI = await sw.evaluate(() => {
        const btns = Array.from(document.querySelectorAll('.authentication-choice .auth-btn'))
        return {
          labels: btns.map((b) => (b.textContent ?? '').trim()),
          disabled: btns.map((b) => (b as HTMLButtonElement).disabled)
        }
      })
      expect(authOpenAI.labels, 'openai-compatible 面认证控件应含禁用说明').toEqual([
        'Bearer',
        'x-api-key（openai-compatible 不可用）'
      ])
      expect(authOpenAI.disabled, 'openai-compatible 下 x-api-key 必须禁用').toEqual([false, true])
      await expect(sw.locator('.auth-warning'), '未知认证缺省必须要求显式选择').toHaveText('请选择认证方式')
      const chosenHelp = sw.locator('.preset-selection .preset-help-link')
      await expect(chosenHelp, '已选模板应保留帮助链接').toHaveCount(1)
      expect(await chosenHelp.getAttribute('href')).toBe('https://api-docs.deepseek.com/')

      // 空格激活 Bearer（键盘可操作性，不只是"能聚焦"）
      const bearer = sw.locator('.auth-btn', { hasText: 'Bearer' })
      await bearer.focus()
      await sw.keyboard.press(' ')
      await expect(bearer).toHaveClass(/auth-active/)

      // ⑦ 切到 Anthropic 面：协议/地址与认证控件一起变
      await sw.locator('.preset-reopen').click()
      await sw.waitForSelector('.preset-picker')
      await sw
        .locator('.preset-dual', { hasText: 'DeepSeek' })
        .locator('.preset-face-btn', { hasText: 'Anthropic' })
        .click()
      await expect(sw.locator('.settings-subpage label', { hasText: '协议类型' }).locator('select')).toHaveValue(
        'anthropic'
      )
      await expect(
        sw.locator('.settings-subpage label', { hasText: '接口地址 baseURL' }).locator('input')
      ).toHaveValue('https://api.deepseek.com/anthropic')
      const authAnthropic = await sw.evaluate(() => {
        const btns = Array.from(document.querySelectorAll('.authentication-choice .auth-btn'))
        return {
          labels: btns.map((b) => (b.textContent ?? '').trim()),
          disabled: btns.map((b) => (b as HTMLButtonElement).disabled)
        }
      })
      expect(authAnthropic.labels, 'Anthropic 面应给两种认证').toEqual(['Bearer', 'x-api-key'])
      expect(authAnthropic.disabled, 'Anthropic 面两种认证都应可用').toEqual([false, false])
      await expect(sw.locator('.auth-warning'), '换模板后认证缺省仍需显式选择').toHaveText('请选择认证方式')
    } finally {
      await h.close()
      await h.cleanup()
    }
  })

  test('模型事实：未知价格显示未知、真实零价显示 0、原生输入与附件解析分栏不互推', async () => {
    const h = await launchApp()
    try {
      await seedProfile(h)
      const sw = await openSettings(h)
      await gotoModelSection(sw)
      await editSeededProfile(sw)

      // ① 全未知模型：价格显示"未知"，上下文/输出回退应用默认（不补 0、不造厂商值）
      await expandByModelId(sw, 's3v10-unknown-model')
      const unknown = await readFacts(sw)
      const unknownRow = (label: string): { value: string; meta: string; known: boolean } => {
        const row = unknown.rows.find((r) => r.label === label)
        expect(row, `缺少事实行：${label}`).toBeTruthy()
        return row as { value: string; meta: string; known: boolean }
      }
      expect(unknownRow('上下文窗口').value, '无来源时上下文窗口取应用默认').toBe('131,072 Token')
      expect(unknownRow('上下文窗口').meta, '回退值来源只能标应用默认').toContain('应用默认')
      expect(unknownRow('最大输出 Token').value).toBe('4,096 Token')
      expect(unknown.priceGroups, '未知价格不应渲染任何分类价格行').toHaveLength(0)
      expect(unknown.priceText, '价格区块应显示未知').toContain('未知')
      expect(unknown.priceText, '未知价格不得被补成 0').not.toContain('USD')
      expect(unknown.fontSizes.length, '事实区字号采样不能为空（否则下面那条是空转）').toBeGreaterThan(0)

      // ② 分栏：原生输入与附件解析各占一栏，字段不交叉
      expect(unknown.columns.map((c) => c.title)).toEqual(['模型原生输入', '附件解析通路'])

      // ③ 已知模型：official / catalog 两层来源 + 真实零价
      await expandByModelId(sw, 's3v10-known-model')
      const known = await readFacts(sw)
      const knownRow = (label: string): { value: string; meta: string; known: boolean } => {
        const row = known.rows.find((r) => r.label === label)
        expect(row, `缺少事实行：${label}`).toBeTruthy()
        return row as { value: string; meta: string; known: boolean }
      }
      expect(knownRow('上下文窗口').value).toBe('100,000 Token')
      expect(knownRow('上下文窗口').meta).toContain('官方')
      expect(knownRow('最大输出 Token').value).toBe('4,096 Token')
      expect(knownRow('最大输出 Token').meta).toContain('目录')

      const nativeCol = known.columns.find((c) => c.title === '模型原生输入')
      const attachCol = known.columns.find((c) => c.title === '附件解析通路')
      expect(nativeCol, '原生输入栏不存在').toBeTruthy()
      expect(attachCol, '附件解析栏不存在').toBeTruthy()
      expect(nativeCol!.labels).toEqual(['原生输入模态', '原生扩展输入'])
      expect(attachCol!.labels).toEqual(['附件解析'])
      expect(nativeCol!.text, '原生扩展输入应显示目录值').toContain('音频、PDF')
      expect(attachCol!.text, '附件解析应显示目录值').toContain('支持（pdf-text）')
      // 两栏不得互相推导：附件解析的解析器名字不许出现在原生输入栏，反之亦然
      expect(nativeCol!.text).not.toContain('pdf-text')
      expect(attachCol!.text).not.toContain('音频、PDF')

      // ④ 真实零价：公开 API 单价显示 0（不是未知）；其余无数据类别仍显示未知
      const publicApi = known.priceGroups.find((g) => g.label === '公开 API 单价')
      expect(known.priceGroups, '四个价格类别应各占一组').toHaveLength(4)
      expect(publicApi, '缺少公开 API 单价类别').toBeTruthy()
      expect(publicApi!.lines, '真实零价必须显示 0').toContain('0 USD / 1M tokens · 输入')
      expect(publicApi!.unknown, '已知零价类别不得显示未知').toEqual([])
      const unknownCats = known.priceGroups.filter((g) => g.label !== '公开 API 单价')
      expect(unknownCats).toHaveLength(3)
      expect(unknownCats.every((g) => g.unknown.includes('未知'))).toBe(true)

      // ⑤ 几何：两栏不重叠、事实区无横向溢出、字号与文字不溢出
      expect(overlaps(nativeCol!.rect, attachCol!.rect), '原生输入与附件解析两栏重叠').toBe(false)
      expect(known.valuesOverflow, '事实值/来源文字不许横向溢出').toEqual([])
      expect(known.fontSizes.length, '事实区字号采样不能为空（否则下面那条是空转）').toBeGreaterThan(0)
      expect(Math.min(...known.fontSizes), '事实区字号不得小于 10.5px').toBeGreaterThanOrEqual(10.5)
      expect(known.factsWidth.scroll - known.factsWidth.client, '事实区不许横向溢出').toBeLessThanOrEqual(2)
      expect(known.bodyWidth.scroll - known.bodyWidth.client, '设置内容区不许横向溢出').toBeLessThanOrEqual(2)
    } finally {
      await h.close()
      await h.cleanup()
    }
  })

  test('用户覆盖：已保存模型的窗口/输出上限真走 metadata patch，set/clear 保留 official/catalog', async () => {
    const h = await launchApp()
    try {
      const { profileId } = await seedProfile(h)
      const sw = await openSettings(h)
      await gotoModelSection(sw)
      await editSeededProfile(sw)
      await expandByModelId(sw, 's3v10-known-model')

      const startedAt = Date.now()
      const override = sw.locator('.mc-override')
      await expect(override.locator('button', { hasText: '保存覆盖' })).toBeVisible()
      await override.locator('input[type="number"]').nth(0).fill('777777')
      await override.locator('input[type="number"]').nth(1).fill('88888')
      await override.locator('button', { hasText: '保存覆盖' }).click()
      await expect(sw.locator('.mc-override-done')).toContainText('已保存用户覆盖')

      // 真值回读：user 层被本次点击盖章（observedAt ≥ startedAt），official/catalog 原样保留
      const afterSet = await apiCall<MetadataLike>(sw, 'getModelMetadata', profileId, 's3v10-known')
      expect(afterSet.contextWindow?.user?.value, '上下文窗口用户覆盖没落盘').toBe(777777)
      expect(afterSet.contextWindow?.user?.observedAt ?? 0, 'observedAt 应由主进程盖章').toBeGreaterThanOrEqual(
        startedAt
      )
      expect(afterSet.contextWindow?.official?.value, 'set 不许清掉 official 层').toBe(100_000)
      expect(afterSet.maxOutputTokens?.user?.value, '最大输出用户覆盖没落盘').toBe(88_888)
      expect(afterSet.maxOutputTokens?.catalog?.value, 'set 不许清掉 catalog 层').toBe(4096)

      // 界面读的是主进程返回值：事实区来源切到用户、数值跟着走
      const afterSetFacts = await readFacts(sw)
      const cwAfterSet = afterSetFacts.rows.find((r) => r.label === '上下文窗口')
      expect(cwAfterSet?.value).toBe('777,777 Token')
      expect(cwAfterSet?.meta).toContain('用户')

      // 清除覆盖：只清 user，回落到 official / catalog
      await override.locator('button', { hasText: '清除覆盖' }).click()
      await expect(sw.locator('.mc-override-done')).toContainText('已清除用户覆盖')
      const afterClear = await apiCall<MetadataLike>(sw, 'getModelMetadata', profileId, 's3v10-known')
      expect(afterClear.contextWindow?.user, 'clear 后 user 层应消失').toBeUndefined()
      expect(afterClear.contextWindow?.official?.value, 'clear 后应回落 official').toBe(100_000)
      expect(afterClear.maxOutputTokens?.user).toBeUndefined()
      expect(afterClear.maxOutputTokens?.catalog?.value, 'clear 后应回落 catalog').toBe(4096)
      const afterClearFacts = await readFacts(sw)
      const cwAfterClear = afterClearFacts.rows.find((r) => r.label === '上下文窗口')
      expect(cwAfterClear?.value).toBe('100,000 Token')
      expect(cwAfterClear?.meta).toContain('官方')
    } finally {
      await h.close()
      await h.cleanup()
    }
  })

  test('未保存模型不发 metadata patch；补丁失败时保留已填草稿', async () => {
    const h = await launchApp()
    try {
      // 主进程侧计数 handler：未保存模型若真发了补丁，计数就不会是 0（公开 API，不碰内部字段）
      await h.app.evaluate(({ ipcMain }) => {
        const g = globalThis as unknown as { __s3v10MetadataPatchCalls?: number }
        g.__s3v10MetadataPatchCalls = 0
        ipcMain.removeHandler('models:patch-metadata')
        ipcMain.handle('models:patch-metadata', () => {
          g.__s3v10MetadataPatchCalls = (g.__s3v10MetadataPatchCalls ?? 0) + 1
          throw new Error('S3-V10 哨兵：未保存模型不该调用 metadata patch')
        })
      })
      const patchCalls = async (): Promise<number> =>
        h.app.evaluate(
          () => (globalThis as unknown as { __s3v10MetadataPatchCalls?: number }).__s3v10MetadataPatchCalls ?? 0
        )

      await seedProfile(h)
      const sw = await openSettings(h)
      await gotoModelSection(sw)
      await editSeededProfile(sw)

      // ① 已保存端点里的**新草稿行**：只给说明，不给覆盖入口，一个 IPC 都不发
      // ⚠️ 「添加模型」自带展开（add() 里 setExpanded(id)）—— 这里**不能再点一次图标**，否则是收起。
      await sw.locator('.mc-foot button', { hasText: '添加模型' }).click()
      const draftRow = sw.locator('.mc-row').last()
      await expect(draftRow, '新加的草稿行应自动展开').toHaveClass(/on/)
      await draftRow.locator('.mc-model').fill('s3v10-draft-model')
      await expect(sw.locator('.mc-adv')).toHaveCount(1)
      const draftFacts = await readFacts(sw)
      expect(draftFacts.override, '未保存草稿也应有覆盖区说明').toBeTruthy()
      expect(draftFacts.override!.text, '未保存草稿应说明先去保存').toContain('该模型尚未保存')
      expect(draftFacts.override!.inputs, '未保存草稿不许出现覆盖输入框').toBe(0)
      expect(
        draftFacts.override!.buttons.some((t) => t.includes('保存覆盖') || t.includes('清除覆盖')),
        '未保存草稿不许出现覆盖按钮'
      ).toBe(false)
      await draftRow.locator('.mc-name').fill('草稿名称')
      await expect(sw.locator('.mc-override-err'), '未保存草稿不该产生失败提示').toHaveCount(0)
      expect(await patchCalls(), '未保存草稿不得调用 metadata patch').toBe(0)

      // ② 新增端点（profileId 未定）同样不发补丁
      await sw.locator('.settings-subpage .back-btn').click()
      await sw.waitForSelector('.model-head')
      await openPresetPicker(sw)
      await sw
        .locator('.preset-dual', { hasText: 'DeepSeek' })
        .locator('.preset-face-btn', { hasText: 'OpenAI 兼容' })
        .click()
      const newRow = sw.locator('.mc-row').first()
      await newRow.locator('.mc-model').fill('s3v10-new-endpoint-model')
      await newRow.locator('.mc-icon:not(.mc-del)').click()
      await expect(sw.locator('.mc-adv')).toHaveCount(1)
      const newFacts = await readFacts(sw)
      expect(newFacts.override!.text).toContain('该模型尚未保存')
      expect(newFacts.override!.buttons.some((t) => t.includes('保存覆盖'))).toBe(false)
      expect(await patchCalls(), '新增端点不得调用 metadata patch').toBe(0)

      // ③ 失败态保留草稿：已保存模型点保存覆盖 → 主进程拒绝 → 错误上屏且已填值不被清掉
      await sw.locator('.settings-subpage .back-btn').click()
      await sw.waitForSelector('.model-head')
      await editSeededProfile(sw)
      await expandByModelId(sw, 's3v10-known-model')
      const override = sw.locator('.mc-override')
      await override.locator('input[type="number"]').nth(0).fill('555555')
      await override.locator('input[type="number"]').nth(1).fill('66666')
      await override.locator('button', { hasText: '保存覆盖' }).click()
      await expect(sw.locator('.mc-override-err'), '失败必须上屏').toContainText('S3-V10 哨兵')
      expect(await patchCalls(), '已保存模型的覆盖必须真的走通道').toBeGreaterThan(0)
      await expect(override.locator('input[type="number"]').nth(0), '失败后已填上下文不许被清空').toHaveValue(
        '555555'
      )
      await expect(override.locator('input[type="number"]').nth(1), '失败后已填输出上限不许被清空').toHaveValue(
        '66666'
      )
      const failedFacts = await readFacts(sw)
      expect(
        failedFacts.rows.find((r) => r.label === '上下文窗口')?.meta ?? '',
        '失败不得伪造用户覆盖'
      ).toContain('官方')
      expect(
        await sw.locator('.mc-row').count(),
        '失败后模型行草稿不应被丢弃'
      ).toBeGreaterThanOrEqual(2)
    } finally {
      await h.close()
      await h.cleanup()
    }
  })
})

// ═══════════════════════════════════════════════════════════════════════════
// S3-V40：有界读取并行的界面入口与本波失败态
// 全部走真入口 + 真 preload + 真 IPC + 阶段私域 userData；本地假 HTTP 不联网。
// ═══════════════════════════════════════════════════════════════════════════

const LONG_BASE_URL = 'https://' + 'a'.repeat(60) + '.' + 'b'.repeat(60) + '.example.com/v1'
const LONG_PROFILE_NAME = 'S3-V40 长地址夹具'

interface AddressLayout {
  body: Rect
  input: Rect
  value: string
  bodyOverflow: number
  labelOverflow: boolean
  hintOverflow: number
  inputRightExcess: number
  activeIsInput: boolean
  activeInside: boolean
  activeTag: string
  focusRing: string
}

/** 只读几何：地址输入框 / 设置内容区 / 焦点环；不读源码推断样式。 */
async function readAddressLayout(sw: Page): Promise<AddressLayout> {
  return sw.evaluate(() => {
    const rect = (el: Element | null): { x: number; y: number; w: number; h: number } => {
      if (!el) return { x: 0, y: 0, w: 0, h: 0 }
      const r = el.getBoundingClientRect()
      return { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height) }
    }
    const body = document.querySelector('.settings-body')
    const subpage = document.querySelector('.settings-subpage')
    const label = Array.from(document.querySelectorAll('.settings-subpage label')).find((el) =>
      (el.textContent ?? '').includes('接口地址 baseURL')
    )
    const input = label?.querySelector('input') as HTMLInputElement | null
    const hintOverflow = Array.from(subpage?.querySelectorAll('.hint') ?? []).filter(
      (el) => el.scrollWidth > el.clientWidth + 1
    ).length
    const style = input ? getComputedStyle(input) : null
    const active = document.activeElement as HTMLElement | null
    const inputRight = input ? input.getBoundingClientRect().right : 0
    const bodyRight = body ? body.getBoundingClientRect().right : 0
    return {
      body: rect(body),
      input: rect(input),
      value: input?.value ?? '',
      bodyOverflow: body ? body.scrollWidth - body.clientWidth : 0,
      labelOverflow: label ? label.scrollWidth > label.clientWidth + 1 : true,
      hintOverflow,
      inputRightExcess: input && body ? Math.round(inputRight - bodyRight) : 999,
      activeIsInput: !!input && active === input,
      activeInside: !!active && !!active.closest('.settings-subpage'),
      activeTag: active ? active.tagName.toLowerCase() : '',
      focusRing: style ? `${style.outlineStyle}|${style.outlineWidth}|${style.boxShadow}` : 'none'
    }
  })
}

function expectAddressFit(snap: AddressLayout, label: string): void {
  expect(snap.value, `${label}：长地址值应完整保留`).toBe(LONG_BASE_URL)
  expect(snap.input.w, `${label}：地址输入框应有真实宽度`).toBeGreaterThan(0)
  expect(snap.input.h, `${label}：地址输入框应有真实高度`).toBeGreaterThan(0)
  expect(snap.inputRightExcess, `${label}：地址输入框不得溢出设置内容区`).toBeLessThanOrEqual(1)
  expect(snap.bodyOverflow, `${label}：设置内容区不得横向溢出`).toBeLessThanOrEqual(2)
  expect(snap.labelOverflow, `${label}：地址标签不得被裁切`).toBe(false)
  expect(snap.hintOverflow, `${label}：提示文字不得横向溢出`).toBe(0)
}

/** 真实设置窗尺寸/缩放（按 URL 认窗口身份，不取任意窗口）。 */
async function setSettingsWindow(
  h: E2EApp,
  opts: { width?: number; height?: number; zoom?: number }
): Promise<void> {
  await h.app.evaluate(({ BrowserWindow }, o) => {
    const win = BrowserWindow.getAllWindows().find((w) => w.webContents.getURL().includes('settings'))
    if (!win) throw new Error('设置窗口未找到')
    if (o.width && o.height) win.setSize(o.width, o.height)
    if (o.zoom) win.webContents.setZoomFactor(o.zoom)
  }, opts)
  await new Promise((r) => setTimeout(r, 350))
}

/** 长地址端点：只落本地档案，不发请求。 */
async function seedLongAddressProfile(h: E2EApp): Promise<{ profileId: string }> {
  const saved = await apiCall<{ id: string }>(h.page, 'saveModel', {
    name: LONG_PROFILE_NAME,
    providerType: 'openai-compatible',
    baseURL: LONG_BASE_URL,
    stream: true,
    timeoutMs: 15_000,
    models: [{ id: 's3v40-long', model: 's3v40-long-model', name: '长地址模型' }],
    apiKey: ''
  })
  expect(saved.id, '长地址端点应回 id').toBeTruthy()
  return { profileId: saved.id }
}

interface FailureServerHandle {
  srv: Server
  port: number
  requests: Array<{ body: string; hasTools: boolean }>
}

/** 本地假失败端点：401 / 429 按用户正文标记返回；无工具的旁路请求给 200。 */
async function startFailureServer(): Promise<FailureServerHandle> {
  const requests: Array<{ body: string; hasTools: boolean }> = []
  const srv = createServer((req, res) => {
    let raw = ''
    req.on('data', (chunk: Buffer) => {
      raw += chunk.toString('utf8')
    })
    req.on('end', () => {
      let parsed: {
        tools?: unknown[]
        messages?: Array<{ role?: string; content?: unknown }>
      } | null = null
      try {
        parsed = JSON.parse(raw) as typeof parsed
      } catch {
        parsed = null
      }
      const hasTools = Array.isArray(parsed?.tools) && parsed.tools.length > 0
      requests.push({ body: raw, hasTools })
      if (!hasTools) {
        res.writeHead(200, { 'content-type': 'text/event-stream' })
        res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: '失败态会话' } }] })}\n\n`)
        res.write(`data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: 'stop' }] })}\n\n`)
        res.end('data: [DONE]\n\n')
        return
      }
      const lastUser = [...(parsed?.messages ?? [])].reverse().find((m) => m.role === 'user')?.content
      const marker = typeof lastUser === 'string' ? lastUser : JSON.stringify(lastUser ?? '')
      const status = marker.includes('S3V40_401') ? 401 : marker.includes('S3V40_429') ? 429 : 500
      res.writeHead(status, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ error: { message: 'S3V40 本地假失败' } }))
    })
  })
  srv.listen(0, '127.0.0.1')
  await once(srv, 'listening')
  return { srv, port: (srv.address() as AddressInfo).port, requests }
}

async function closeFailureServer(handle: FailureServerHandle | null): Promise<void> {
  if (!handle) return
  handle.srv.closeAllConnections()
  await new Promise<void>((resolve) => handle.srv.close(() => resolve()))
}

/** 造一条端点并设为当前模型；baseURL 默认指向不可达的本机端口（本故事不发请求） */
async function seedPlainProfile(
  h: E2EApp,
  models: Array<{ id: string; model: string; name: string }>,
  name = 'S3-V40 夹具',
  baseURL = 'http://127.0.0.1:9/v1',
  apiKey = ''
): Promise<{ id: string }> {
  const saved = await apiCall<{ id: string }>(h.page, 'saveModel', {
    name,
    providerType: 'openai-compatible',
    baseURL,
    stream: true,
    timeoutMs: 15_000,
    models,
    apiKey
  })
  expect(saved.id, '保存端点应回 id').toBeTruthy()
  await apiCall(h.page, 'setActiveModel', saved.id)
  await h.page.reload()
  await expect(h.page.locator('.sidebar')).toBeVisible({ timeout: 30_000 })
  return { id: saved.id }
}

test.describe('S3-V40 有界读取并行入口与失败态', () => {
  test('长地址在真实窄窗与 125%/150% 缩放下的几何、换行与焦点环', async () => {
    const h = await launchApp()
    try {
      console.log(
        'S3V40_ISOLATION=' +
          JSON.stringify({ pid: h.app.process().pid, dataDir: h.dataDir, workspaceDir: h.workspaceDir })
      )
      await seedLongAddressProfile(h)
      const sw = await openSettings(h)
      await gotoModelSection(sw)
      const row = sw.locator('.model-row', { hasText: LONG_PROFILE_NAME })
      await expect(row, '长地址夹具应出现在模型列表').toHaveCount(1)
      await row.locator('[title="编辑该模型"]').click()
      await sw.waitForSelector('.settings-subpage .mc', { timeout: 15_000 })
      const addr = sw
        .locator('.settings-subpage label', { hasText: '接口地址 baseURL' })
        .locator('input')
      await expect(addr, '长地址必须原样读回').toHaveValue(LONG_BASE_URL)

      const base = await readAddressLayout(sw)
      console.log('S3V40_LAYOUT=' + JSON.stringify({ at: 'base', ...base }))
      expectAddressFit(base, '默认 900x660')

      await addr.focus()
      const focused = await readAddressLayout(sw)
      console.log('S3V40_LAYOUT=' + JSON.stringify({ at: 'focus', ...focused }))
      expect(focused.activeIsInput, '地址输入框应可聚焦').toBe(true)
      expect(focused.focusRing, '地址输入框聚焦时必须有可见焦点环').toMatch(/solid|auto|inset|rgb|px/)
      await sw.keyboard.press('Tab')
      const tabbed = await readAddressLayout(sw)
      expect(tabbed.activeIsInput, 'Tab 后焦点应离开地址输入框').toBe(false)
      expect(tabbed.activeInside, 'Tab 后焦点仍应落在设置二级页内').toBe(true)

      await setSettingsWindow(h, { width: 720, height: 560 })
      const narrow = await readAddressLayout(sw)
      console.log('S3V40_LAYOUT=' + JSON.stringify({ at: 'narrow720', ...narrow }))
      expectAddressFit(narrow, '真实最小窄窗 720x560')

      await setSettingsWindow(h, { zoom: 1.25 })
      const z125 = await readAddressLayout(sw)
      console.log('S3V40_LAYOUT=' + JSON.stringify({ at: 'zoom125', ...z125 }))
      expectAddressFit(z125, '125% 缩放')

      await setSettingsWindow(h, { zoom: 1.5 })
      const z150 = await readAddressLayout(sw)
      console.log('S3V40_LAYOUT=' + JSON.stringify({ at: 'zoom150', ...z150 }))
      expectAddressFit(z150, '150% 缩放')
      await addr.focus()
      const z150Focused = await readAddressLayout(sw)
      expect(z150Focused.focusRing, '150% 缩放下焦点环仍可见').toMatch(/solid|auto|inset|rgb|px/)

      await setSettingsWindow(h, { width: 900, height: 660, zoom: 1 })
    } finally {
      await h.close()
      await h.cleanup()
    }
  })

  test('失败态 401 / 429 / 断网：错误可解释且不误报成功', async () => {
    const h = await launchApp()
    let server: FailureServerHandle | null = null
    try {
      const encryptionAvailable = await h.app.evaluate(({ safeStorage }) =>
        safeStorage.isEncryptionAvailable()
      )
      test.skip(!encryptionAvailable, '本地假端点发送需要 safeStorage；仅跳本故事')
      server = await startFailureServer()
      await seedPlainProfile(
        h,
        [{ id: 's3v40-fail', model: 's3v40-fail-model', name: '失败模型',  }],
        'S3-V40 失败夹具',
        `http://127.0.0.1:${server.port}/v1`,
        '{{SECRET_s3v40_local_only}}'
      )
      await h.page.locator('.sidebar .new-task-btn').click()
      await expect(h.page.locator('.new-task')).toBeVisible()

      await h.page.locator('textarea.console-input').fill('S3V40_401 认证失败轮')
      await h.page.locator('textarea.console-input').press('Enter')
      await expect(h.page.locator('.msg-terminal[data-terminal-state="failed"]')).toHaveCount(1, {
        timeout: 30_000
      })
      await expect(h.page.locator('.chat-error'), '401 应给出可解释的认证错误').toContainText(
        '认证失败（401）'
      )
      await expect(h.page.locator('.msg-terminal[data-terminal-state="completed"]')).toHaveCount(0)

      await h.page.locator('textarea.console-input').fill('S3V40_429 限流失败轮')
      await h.page.locator('textarea.console-input').press('Enter')
      await expect(h.page.locator('.msg-terminal[data-terminal-state="failed"]')).toHaveCount(2, {
        timeout: 30_000
      })
      await expect(h.page.locator('.chat-error'), '429 应给出可解释的限流错误').toContainText(
        '请求过频或额度不足（429）'
      )
      await expect(h.page.locator('.msg-terminal[data-terminal-state="completed"]')).toHaveCount(0)

      const closedPort = server.port
      await closeFailureServer(server)
      server = null
      await seedPlainProfile(
        h,
        [{ id: 's3v40-offline', model: 's3v40-offline-model', name: '断网模型',  }],
        'S3-V40 断网夹具',
        `http://127.0.0.1:${closedPort}/v1`,
        '{{SECRET_s3v40_offline_only}}'
      )
      await h.page.locator('.sidebar .new-task-btn').click()
      await expect(h.page.locator('.new-task')).toBeVisible()
      await h.page.locator('textarea.console-input').fill('S3V40_OFFLINE 断网轮')
      await h.page.locator('textarea.console-input').press('Enter')
      await expect(h.page.locator('.msg-terminal[data-terminal-state="failed"]')).toHaveCount(1, {
        timeout: 30_000
      })
      const offlineError = (await h.page.locator('.chat-error').innerText()).trim()
      console.log('S3V40_OFFLINE_ERROR=' + JSON.stringify(offlineError))
      expect(offlineError.length, '断网必须给出可见错误，不得静默').toBeGreaterThan(0)
      expect(offlineError, '断网错误必须可解释，且不得宣称成功').toMatch(
        /fetch|网络|连接|失败|refused|ERR_/i
      )
      expect(offlineError, '断网不得误报成功').not.toMatch(/成功|已完成/)
      await expect(h.page.locator('.msg-terminal[data-terminal-state="completed"]')).toHaveCount(0)
    } finally {
      await closeFailureServer(server)
      await h.close()
      await h.cleanup()
    }
  })

})
