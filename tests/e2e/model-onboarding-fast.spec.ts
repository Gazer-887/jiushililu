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
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { apiCall, launchApp, type E2EApp } from './helpers'

/** 种子时间戳：早于任何一次用户覆盖，用来区分"官方/目录层"与"本次盖章" */
const SEED_TS = 1758000000000
const PROFILE_NAME = 'S3-V10 元数据夹具'
/** 截图落点：默认项目 tmp；S3-V40 私域验证用 S3V40_SHOT_DIR 指到阶段运行域。 */
const SHOT_DIR = process.env.S3V40_SHOT_DIR ?? 'tmp'

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

// ══ S3-20V：默认速度 / 会话覆盖的真实 Electron 故事 ══════════════════════════
// 全部用阶段私域 userData（launchApp 的临时目录）与本地 127.0.0.1 假 HTTP；
// 不联网、不打真实供应商、不读真实用户配置。断言只认主进程真值与真界面读数。

const SPEED_PROFILE_NAME = 'S3-20V 速度夹具'

interface ModelsViewLike {
  profiles: Array<{ id: string; models: Array<{ id: string; speedMode?: string }> }>
}
interface UIPrefsLike {
  conversationSpeedOverrides: Record<string, string>
}
interface SpeedChipSnapshot {
  view: string
  value: string | null
  disabled: boolean | null
  effectiveText: string
  chipTitle: string
  options: Array<{ value: string; label: string }>
  chipRect: Rect | null
  selectRect: Rect | null
  overflow: string[]
  barOverflow: number | null
}
interface SpeedRowSnapshot {
  label: string
  value: string | null
  disabled: boolean | null
  options: Array<{ value: string; label: string }>
  nameRect: Rect | null
  selectRect: Rect | null
  overflow: number
  fontSizes: number[]
}

/** 读输入区速度控件（值 / 禁用 / 有效档 / 来源 / 几何 / 溢出） */
async function readSpeedChip(page: Page): Promise<SpeedChipSnapshot> {
  return page.evaluate(() => {
    const rect = (el: Element | null): { x: number; y: number; w: number; h: number } | null => {
      if (!el) return null
      const r = el.getBoundingClientRect()
      return { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height) }
    }
    const sel = document.querySelector('.speed-select') as HTMLSelectElement | null
    const chip = document.querySelector('.speed-chip')
    const eff = document.querySelector('.speed-effective')
    const bar = document.querySelector('.console-toolbar')
    const texts = [
      document.querySelector('.speed-chip-label'),
      eff,
      document.querySelector('.speed-source'),
      document.querySelector('.speed-next')
    ]
    return {
      view: document.querySelector('.chat-view')
        ? 'chat'
        : document.querySelector('.new-task')
          ? 'new-task'
          : '?',
      value: sel ? sel.value : null,
      disabled: sel ? sel.disabled : null,
      effectiveText: eff ? (eff.textContent ?? '').trim() : '',
      chipTitle: chip ? (chip.getAttribute('title') ?? '') : '',
      options: sel
        ? Array.from(sel.options).map((o) => ({ value: o.value, label: (o.textContent ?? '').trim() }))
        : [],
      chipRect: rect(chip),
      selectRect: rect(sel),
      overflow: texts
        .filter((el): el is Element => el !== null && el.scrollWidth > el.clientWidth + 1)
        .map((el) => (el.textContent ?? '').trim()),
      barOverflow: bar ? bar.scrollWidth - bar.clientWidth : null
    }
  })
}

/** 读设置页逐模型默认速度行（标签 / 值 / 选项 / 几何 / 溢出） */
async function readSpeedRows(sw: Page): Promise<SpeedRowSnapshot[]> {
  return sw.evaluate(() =>
    Array.from(document.querySelectorAll('.model-speed-row')).map((row) => {
      const rect = (el: Element | null): { x: number; y: number; w: number; h: number } | null => {
        if (!el) return null
        const r = el.getBoundingClientRect()
        return { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height) }
      }
      const nameEl = row.querySelector('.model-speed-name')
      const sel = row.querySelector('.model-speed-select') as HTMLSelectElement | null
      const texts = [nameEl, sel].filter((el): el is Element => el !== null)
      return {
        label: nameEl ? (nameEl.textContent ?? '').trim() : '',
        value: sel ? sel.value : null,
        disabled: sel ? sel.disabled : null,
        options: sel
          ? Array.from(sel.options).map((o) => ({ value: o.value, label: (o.textContent ?? '').trim() }))
          : [],
        nameRect: rect(nameEl),
        selectRect: rect(sel),
        overflow: texts.filter((el) => el.scrollWidth > el.clientWidth + 1).length,
        fontSizes: texts.map((el) => parseFloat(getComputedStyle(el).fontSize))
      }
    })
  )
}

/** 从模型列表进指定端点的编辑二级页（速度面板在二级页里） */
async function editProfileByName(sw: Page, name: string): Promise<void> {
  const row = sw.locator('.model-row', { hasText: name })
  await expect(row, '种子端点应出现在模型列表').toHaveCount(1)
  await row.locator('[title="编辑该模型"]').click()
  await sw.waitForSelector('.settings-subpage .mc', { timeout: 15_000 })
}

/** 设置页改某条模型的默认速度（原生 select，走真实 change） */
async function setRowSpeed(sw: Page, label: string, value: 'normal' | 'fast'): Promise<void> {
  const row = sw.locator('.model-speed-row', { hasText: label })
  await expect(row, `速度行不存在：${label}`).toHaveCount(1)
  await row.locator('.model-speed-select').selectOption(value)
}

/** 保存端点（编辑态按钮文案「保存修改」），等主进程回执上屏 */
async function saveSpeedProfile(sw: Page): Promise<void> {
  await sw.locator('.settings-subpage button', { hasText: '保存修改' }).click()
  await expect(sw.locator('.notice-ok'), '保存必须有成功回执').toContainText('已保存')
}

/** 关闭设置窗口并等到它真的消失（再开会拿到新进程，读回才是落盘值） */
async function closeSettings(h: E2EApp, sw: Page): Promise<void> {
  await sw.locator('.settings-window-back').click()
  await expect
    .poll(() => h.app.windows().filter((w) => w.url().includes('settings')).length, { timeout: 15_000 })
    .toBe(0)
}

/** 造一条速度端点并设为当前模型；baseURL 默认指向不可达的本机端口（本故事不发请求） */
async function seedSpeedProfile(
  h: E2EApp,
  models: Array<{ id: string; model: string; name: string; speedMode: 'normal' | 'fast' }>,
  name = SPEED_PROFILE_NAME,
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

/** 点侧栏会话并等它成为活动会话（窗口身份纪律：按 class + 标题定位，不取任意窗口） */
async function openConversationByTitle(page: Page, title: string): Promise<void> {
  const item = page.locator('.conv-item', { hasText: title }).first()
  await expect(item, `会话不存在：${title}`).toHaveCount(1)
  await item.click()
  await expect(page.locator('.chat-view')).toBeVisible({ timeout: 15_000 })
  await expect(page.locator('.conv-item.active')).toContainText(title)
  await expect(page.locator('.speed-select')).toBeVisible({ timeout: 15_000 })
}

/** 读主进程真实偏好（不经渲染端内存），并等某个会话的覆盖值落定 */
async function waitSpeedOverride(
  h: E2EApp,
  conversationId: string,
  expected: string
): Promise<Record<string, string>> {
  await expect
    .poll(
      async () => (await apiCall<UIPrefsLike>(h.page, 'getUIPrefs')).conversationSpeedOverrides,
      { timeout: 15_000, message: `会话 ${conversationId} 的速度覆盖没落盘` }
    )
    .toMatchObject({ [conversationId]: expected })
  return (await apiCall<UIPrefsLike>(h.page, 'getUIPrefs')).conversationSpeedOverrides
}

test.describe('S3-20V 模型默认速度与会话覆盖：真实 Electron 故事', () => {
  test('模型默认速度：A 普通 / B FAST，经编辑、保存、重开可读回', async () => {
    const h = await launchApp()
    try {
      const { id: profileId } = await seedSpeedProfile(h, [
        { id: 's3v20-a', model: 's3v20-model-a', name: '速度甲', speedMode: 'normal' },
        { id: 's3v20-b', model: 's3v20-model-b', name: '速度乙', speedMode: 'fast' }
      ])
      let sw = await openSettings(h)
      await gotoModelSection(sw)
      await editProfileByName(sw, SPEED_PROFILE_NAME)

      // ① 初值从主进程档案读回：A 普通、B FAST
      let rows = await readSpeedRows(sw)
      expect(rows.map((r) => r.label), '两条模型各一行').toEqual(['速度甲', '速度乙'])
      expect(rows.map((r) => r.value), 'A 普通 / B FAST 的默认值应读回').toEqual(['normal', 'fast'])
      expect(rows[0].options.map((o) => o.label), '只允许普通 / FAST 策略两档').toEqual([
        '普通',
        'FAST 策略'
      ])
      expect(rows.every((r) => r.disabled === false), '已保存端点的速度选择器应可操作').toBe(true)
      expect(rows.every((r) => r.nameRect && r.selectRect && r.nameRect.w > 0 && r.selectRect.w > 0)).toBe(
        true
      )
      expect(
        rows.map((r) => r.nameRect!.x + r.nameRect!.w <= r.selectRect!.x + 1),
        '模型名与选择器不得重叠'
      ).toEqual([true, true])
      expect(rows.every((r) => r.overflow === 0), '速度行文字不得被裁切').toBe(true)
      expect(Math.min(...rows.flatMap((r) => r.fontSizes)), '速度控件字号 ≥ 10.5px').toBeGreaterThanOrEqual(
        10.5
      )
      const hint = await sw.locator('.model-speed-head .hint').innerText()
      expect(hint, '必须说明 FAST 只是请求策略').toContain('请求策略')
      expect(hint, '是否实际使用快速服务档由厂商决定').toContain('由厂商能力声明与响应决定')
      expect(hint, '不得声称厂商已提供快速服务档').not.toContain('已启用')

      // ② 改草稿：保存前主进程真值不动（选择与落盘是两步）
      await setRowSpeed(sw, '速度甲', 'fast')
      await setRowSpeed(sw, '速度乙', 'normal')
      const beforeSave = await apiCall<ModelsViewLike>(h.page, 'listModels')
      const beforeModels = beforeSave.profiles.find((p) => p.id === profileId)!.models
      expect(beforeModels.map((m) => m.speedMode), '未保存前主进程档案不得被改').toEqual([
        'normal',
        'fast'
      ])

      // ③ 保存：真实 saveModel 链落盘
      await saveSpeedProfile(sw)
      const afterSave = await apiCall<ModelsViewLike>(h.page, 'listModels')
      const afterModels = afterSave.profiles.find((p) => p.id === profileId)!.models
      expect(afterModels[0].speedMode, 'A 保存后应为 FAST').toBe('fast')
      expect(afterModels[1].speedMode, 'B 保存后应为普通').toBe('normal')

      // ④ 关窗重开：从盘上读回，不是内存残留
      await closeSettings(h, sw)
      sw = await openSettings(h)
      await gotoModelSection(sw)
      await editProfileByName(sw, SPEED_PROFILE_NAME)
      rows = await readSpeedRows(sw)
      expect(rows.map((r) => r.value), '重开后应按落盘值读回').toEqual(['fast', 'normal'])
    } finally {
      await h.close()
      await h.cleanup()
    }
  })

  test('两会话速度覆盖互不影响：A 覆盖普通、B 继承 FAST，重启后仍按各自选择', async () => {
    const first = await launchApp()
    let current: E2EApp | null = first
    try {
      await seedSpeedProfile(first, [
        { id: 's3v20-solo', model: 's3v20-model-solo', name: '速度唯一', speedMode: 'fast' }
      ])
      const ws = await apiCall<{ path: string }>(first.page, 'getWorkspace')
      const convA = await apiCall<{ id: string }>(first.page, 'createConversation', {
        workspace: ws.path,
        model: 's3v20-model-solo',
        firstMessage: '会话A'
      })
      const convB = await apiCall<{ id: string }>(first.page, 'createConversation', {
        workspace: ws.path,
        model: 's3v20-model-solo',
        firstMessage: '会话B'
      })
      await first.page.reload()
      await expect(first.page.locator('.conv-item')).toHaveCount(2)

      // ① A：继承模型默认 FAST
      await openConversationByTitle(first.page, '会话A')
      await expect.poll(async () => (await readSpeedChip(first.page)).effectiveText).toContain('FAST')
      let chip = await readSpeedChip(first.page)
      expect(chip.value, 'A 初始应继承').toBe('inherit')
      expect(chip.effectiveText, 'A 有效档应为模型默认 FAST').toContain('模型默认')

      // ② A 覆盖普通：落盘只有 A 一个键
      await first.page.locator('.speed-select').selectOption('normal')
      await waitSpeedOverride(first, convA.id, 'normal')
      chip = await readSpeedChip(first.page)
      expect(chip.effectiveText).toContain('普通')
      expect(chip.effectiveText).toContain('会话覆盖')

      // ③ B：继承 FAST，不被 A 污染
      await openConversationByTitle(first.page, '会话B')
      chip = await readSpeedChip(first.page)
      expect(chip.value, 'B 应保持继承').toBe('inherit')
      expect(chip.effectiveText, 'B 应显示模型默认 FAST').toContain('FAST')
      expect(chip.effectiveText).toContain('模型默认')
      let prefs = await apiCall<UIPrefsLike>(first.page, 'getUIPrefs')
      expect(prefs.conversationSpeedOverrides, 'B 不得凭空生成覆盖').toEqual({
        [convA.id]: 'normal'
      })

      // ④ 盘上文件与主进程同值（不是只存在渲染端内存）
      const diskPath = join(first.dataDir, 'ui-prefs.json')
      expect(existsSync(diskPath), 'ui-prefs.json 应已落盘').toBe(true)
      const disk = JSON.parse(readFileSync(diskPath, 'utf8')) as UIPrefsLike
      expect(disk.conversationSpeedOverrides).toEqual({ [convA.id]: 'normal' })

      // ⑤ 切回 A：覆盖仍在
      await openConversationByTitle(first.page, '会话A')
      chip = await readSpeedChip(first.page)
      expect(chip.value).toBe('normal')
      expect(chip.effectiveText).toContain('会话覆盖')

      // ⑥ 重启（同一私域 userData）：两条会话各自的选择都还在
      await first.close()
      current = null
      current = await launchApp({ reuseDataDir: first.dataDir })
      await openConversationByTitle(current.page, '会话A')
      await expect.poll(async () => (await readSpeedChip(current!.page)).value).toBe('normal')
      chip = await readSpeedChip(current.page)
      expect(chip.effectiveText, '重启后 A 仍是会话覆盖普通').toContain('会话覆盖')
      await openConversationByTitle(current.page, '会话B')
      chip = await readSpeedChip(current.page)
      expect(chip.value, '重启后 B 仍继承').toBe('inherit')
      expect(chip.effectiveText, '重启后 B 仍是模型默认 FAST').toContain('FAST')
      prefs = await apiCall<UIPrefsLike>(current.page, 'getUIPrefs')
      expect(prefs.conversationSpeedOverrides, '重启后仍只有 A 的覆盖').toEqual({
        [convA.id]: 'normal'
      })
      expect(convB.id).not.toBe(convA.id)
    } finally {
      if (current) await current.close()
      await first.cleanup()
    }
  })

  test('新建任务页（无活动会话）不创建速度覆盖，选择器禁用并显示当前模型默认', async () => {
    const h = await launchApp()
    try {
      await seedSpeedProfile(h, [
        { id: 's3v20-newtask', model: 's3v20-newtask-model', name: '新建页模型', speedMode: 'fast' }
      ])
      // 全新私域目录：没有任何会话
      expect(await apiCall<unknown[]>(h.page, 'listConversations')).toHaveLength(0)
      await h.page.locator('.sidebar .new-task-btn').click()
      await expect(h.page.locator('.new-task')).toBeVisible()

      const chip = await readSpeedChip(h.page)
      expect(chip.view).toBe('new-task')
      expect(chip.disabled, '无活动会话时必须禁用').toBe(true)
      expect(chip.value, '无活动会话时值恒为 inherit').toBe('inherit')
      expect(chip.effectiveText, '必须明确显示当前模型默认 FAST').toContain('FAST')
      expect(chip.effectiveText).toContain('模型默认')
      expect(chip.chipTitle, '应说明新建任务尚无会话可覆盖').toContain('新建任务尚未创建会话')
      expect(chip.options.map((o) => o.value), '三档选项即在，只是禁用').toEqual([
        'inherit',
        'normal',
        'fast'
      ])

      // 伪造 change 事件：禁用控件的真实用户操作不可能发生；即使伪造，也不许写覆盖/建会话
      const prefsBefore = await apiCall<UIPrefsLike>(h.page, 'getUIPrefs')
      const convsBefore = await apiCall<unknown[]>(h.page, 'listConversations')
      await h.page.evaluate(() => {
        const sel = document.querySelector('.speed-select') as HTMLSelectElement | null
        if (!sel) return
        sel.value = 'normal'
        sel.dispatchEvent(new Event('change', { bubbles: true }))
      })
      await h.page.waitForTimeout(400)
      const prefsAfter = await apiCall<UIPrefsLike>(h.page, 'getUIPrefs')
      expect(prefsAfter.conversationSpeedOverrides, '伪造事件不得写入任何覆盖').toEqual(
        prefsBefore.conversationSpeedOverrides
      )
      expect(await apiCall<unknown[]>(h.page, 'listConversations'), '不得顺手创建会话').toHaveLength(
        convsBefore.length
      )
      // 重新进新建页：选择器仍处于 inherit（界面真值由 state 决定，不被伪造 DOM 事件带走）
      await h.page.locator('.sidebar .new-task-btn').click()
      await expect(h.page.locator('.new-task')).toBeVisible()
      const chipAfter = await readSpeedChip(h.page)
      expect(chipAfter.disabled).toBe(true)
      expect(chipAfter.value).toBe('inherit')
      expect(chipAfter.effectiveText).toContain('FAST')
      expect(chipAfter.effectiveText).toContain('模型默认')
      expect(chipAfter.overflow, '新建页速度控件文字不得溢出').toEqual([])
      expect(chipAfter.barOverflow, '工具条不得横向溢出').toBeLessThanOrEqual(2)
    } finally {
      await h.close()
      await h.cleanup()
    }
  })

  test('运行中把会话从普通改为 FAST：本轮不重启，正文/终态/用量不重置，下一轮才用新策略', async () => {
    const h = await launchApp()
    let srv: Server | null = null
    const chatRequests: Array<{ at: number; hasTools: boolean; body: string }> = []
    try {
      const encryptionAvailable = await h.app.evaluate(({ safeStorage }) =>
        safeStorage.isEncryptionAvailable()
      )
      const skipReason = '真实发送的本地假模型需要 safeStorage；仅跳此发送故事，不跳其余速度故事'
      if (!encryptionAvailable) {
        console.log(
          `S3V20_SPEED_RUN_SKIP=${JSON.stringify({ encryptionAvailable, reason: skipReason })}`
        )
      }
      test.skip(!encryptionAvailable, skipReason)

      srv = createServer((req, res) => {
        let raw = ''
        req.on('data', (chunk: Buffer) => {
          raw += chunk.toString('utf8')
        })
        req.on('end', () => {
          let parsed: { tools?: unknown[] } | null = null
          try {
            parsed = JSON.parse(raw) as { tools?: unknown[] }
          } catch {
            parsed = null
          }
          const hasTools = Array.isArray(parsed?.tools) && parsed.tools.length > 0
          chatRequests.push({ at: Date.now(), hasTools, body: raw })
          res.writeHead(200, { 'content-type': 'text/event-stream' })
          if (!hasTools) {
            // 智能标题等旁路请求：立刻回一句文本，不拖慢主链路
            res.write(
              `data: ${JSON.stringify({ choices: [{ delta: { content: '速度会话' } }] })}\n\n`
            )
            res.write(
              `data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: 'stop' }] })}\n\n`
            )
            res.end('data: [DONE]\n\n')
            return
          }
          const isSecond = raw.includes('S3V20_SECOND')
          res.write(
            `data: ${JSON.stringify({ choices: [{ delta: { content: isSecond ? 'SECOND_REPLY' : 'RUN_' } }] })}\n\n`
          )
          setTimeout(() => {
            res.write(
              `data: ${JSON.stringify({ choices: [{ delta: { content: isSecond ? '_DONE' : 'DONE' } }] })}\n\n`
            )
            res.write(
              `data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: 'stop' }] })}\n\n`
            )
            res.write(
              `data: ${JSON.stringify({ choices: [], usage: { prompt_tokens: 21, completion_tokens: 9 } })}\n\n`
            )
            res.end('data: [DONE]\n\n')
          }, isSecond ? 100 : 1500)
        })
      })
      srv.listen(0, '127.0.0.1')
      await once(srv, 'listening')
      const port = (srv.address() as AddressInfo).port

      await seedSpeedProfile(
        h,
        [
          {
            id: 's3v20-run',
            model: 's3v20-run-model',
            name: '运行速度',
            speedMode: 'normal'
          }
        ],
        'S3-20V 运行夹具',
        `http://127.0.0.1:${port}/v1`,
        // 本地假 Key：只走 safeStorage 加密落盘与 hasApiKey 闸，不连接任何真实供应商
        '{{SECRET_s3v20_local_only}}'
      )
      await h.page.locator('.sidebar .new-task-btn').click()
      await expect(h.page.locator('.new-task')).toBeVisible()
      const initialChip = await readSpeedChip(h.page)
      expect(initialChip.effectiveText, '首轮启动前有效档应是模型默认普通').toContain('普通')
      expect(initialChip.effectiveText).toContain('模型默认')

      // ① 发起第一轮（新建任务页直接发送）
      await h.page.locator('textarea.console-input').fill('S3V20_RUN 请流式回复')
      await h.page.locator('textarea.console-input').press('Enter')
      await expect(h.page.locator('.msg-assistant').last()).toContainText('RUN_', { timeout: 30_000 })
      await expect(h.page.locator('.speed-next'), '运行中改速度必须提示「下一轮生效」').toHaveText(
        '下一轮生效'
      )
      const toolRequestsAtStart = chatRequests.filter((r) => r.hasTools)
      expect(toolRequestsAtStart, '运行中应只有一个请求在飞').toHaveLength(1)
      const convs = await apiCall<Array<{ id: string }>>(h.page, 'listConversations')
      expect(convs.length).toBeGreaterThanOrEqual(1)
      const conversationId = convs[0].id

      // ② 运行中把当前会话从普通改为 FAST
      const changedAt = Date.now()
      await h.page.locator('.speed-select').selectOption('fast')
      await waitSpeedOverride(h, conversationId, 'fast')
      const during = await readSpeedChip(h.page)
      expect(during.effectiveText, '界面立刻显示新意图 FAST').toContain('FAST')
      expect(during.effectiveText).toContain('会话覆盖')
      await expect(h.page.locator('.speed-next'), '仍在运行中，提示继续显示').toHaveText('下一轮生效')
      await h.page.waitForTimeout(350)
      expect(
        chatRequests.filter((r) => r.hasTools),
        '改偏好不得重启/补发当前请求'
      ).toHaveLength(1)

      // ③ 本轮完成：正文、终态、用量都不因偏好切换被重置
      await expect(h.page.locator('.msg-assistant').last()).toContainText('RUN_DONE', {
        timeout: 30_000
      })
      await expect(h.page.locator('.msg-terminal[data-terminal-state="completed"]')).toHaveCount(1)
      const savedAfterFirst = await apiCall<{
        messages: Array<{ role: string; content: string; terminal?: { state?: string } }>
        usage?: { promptTokens?: number; completionTokens?: number }
        usageReported?: boolean
      }>(h.page, 'getConversation', conversationId)
      const assistants = savedAfterFirst.messages.filter((m) => m.role === 'assistant')
      expect(assistants).toHaveLength(1)
      expect(assistants[0].content, '正文不得被偏好切换清空/重来').toContain('RUN_DONE')
      expect(assistants[0].terminal?.state, '终态必须保留 completed').toBe('completed')
      expect(savedAfterFirst.usageReported, '用量必须来自真实上报').toBe(true)
      expect(savedAfterFirst.usage?.completionTokens ?? 0, '用量不得被清零').toBeGreaterThan(0)
      expect(chatRequests.filter((r) => r.hasTools), '完成后仍只有一个请求').toHaveLength(1)

      // ④ 下一轮：在偏好切换之后发出，且发送时界面意图已是 FAST
      const beforeSecond = await readSpeedChip(h.page)
      expect(beforeSecond.effectiveText, '下一轮发送前有效档应为 FAST').toContain('FAST')
      expect(beforeSecond.effectiveText).toContain('会话覆盖')
      await h.page.locator('textarea.console-input').fill('S3V20_SECOND 第二轮')
      await h.page.locator('textarea.console-input').press('Enter')
      await expect(h.page.locator('.msg-assistant')).toHaveCount(2, { timeout: 30_000 })
      await expect(h.page.locator('.msg-assistant').last()).toContainText('SECOND_REPLY_DONE', {
        timeout: 30_000
      })
      const toolRequests = chatRequests.filter((r) => r.hasTools)
      expect(toolRequests, '第二轮应发起第二个请求').toHaveLength(2)
      expect(toolRequests[1].at, '下一轮请求必须发生在偏好切换之后').toBeGreaterThan(changedAt)
      expect(toolRequests[1].body, '第二个请求携带的是第二轮正文').toContain('S3V20_SECOND')

      // ⑤ 第二次完成后：第一轮正文与终态仍在，用量只增不减
      const savedAfterSecond = await apiCall<{
        messages: Array<{ role: string; content: string; terminal?: { state?: string } }>
        usage?: { completionTokens?: number }
      }>(h.page, 'getConversation', conversationId)
      const allAssistants = savedAfterSecond.messages.filter((m) => m.role === 'assistant')
      expect(allAssistants).toHaveLength(2)
      expect(allAssistants[0].content, '第一轮正文不得被第二轮冲掉').toContain('RUN_DONE')
      expect(allAssistants[0].terminal?.state).toBe('completed')
      expect(allAssistants[1].content).toContain('SECOND_REPLY_DONE')
      expect(
        savedAfterSecond.usage?.completionTokens ?? 0,
        '用量应累计，不得被偏好切换重置'
      ).toBeGreaterThan(savedAfterFirst.usage?.completionTokens ?? 0)
    } finally {
      if (srv) {
        srv.closeAllConnections()
        await new Promise<void>((resolve) => srv!.close(() => resolve()))
      }
      await h.close()
      await h.cleanup()
    }
  })

  test('删除某个会话只清它自己的速度覆盖，另一会话的覆盖原样保留', async () => {
    const h = await launchApp()
    try {
      await seedSpeedProfile(h, [
        { id: 's3v20-del', model: 's3v20-model-del', name: '删除夹具', speedMode: 'fast' }
      ])
      const ws = await apiCall<{ path: string }>(h.page, 'getWorkspace')
      const convA = await apiCall<{ id: string }>(h.page, 'createConversation', {
        workspace: ws.path,
        model: 's3v20-model-del',
        firstMessage: '删除会话A'
      })
      const convB = await apiCall<{ id: string }>(h.page, 'createConversation', {
        workspace: ws.path,
        model: 's3v20-model-del',
        firstMessage: '保留会话B'
      })
      await h.page.reload()
      await expect(h.page.locator('.conv-item')).toHaveCount(2)

      // A 覆盖普通、B 覆盖 FAST：两条都落盘
      await openConversationByTitle(h.page, '删除会话A')
      await h.page.locator('.speed-select').selectOption('normal')
      await waitSpeedOverride(h, convA.id, 'normal')
      await openConversationByTitle(h.page, '保留会话B')
      await h.page.locator('.speed-select').selectOption('fast')
      await waitSpeedOverride(h, convB.id, 'fast')
      let prefs = await apiCall<UIPrefsLike>(h.page, 'getUIPrefs')
      expect(prefs.conversationSpeedOverrides).toEqual({
        [convA.id]: 'normal',
        [convB.id]: 'fast'
      })

      // 删 A（真实 UI 路径：会话菜单 → 删除）；B 仍是活动会话
      const aItem = h.page.locator('.conv-item', { hasText: '删除会话A' }).first()
      await aItem.locator('.conv-more').click()
      await aItem.locator('.conv-menu button', { hasText: '删除' }).click()
      await expect(h.page.locator('.conv-item', { hasText: '删除会话A' })).toHaveCount(0)

      // 只清 A，B 的覆盖与界面都还在
      await expect
        .poll(async () => (await apiCall<UIPrefsLike>(h.page, 'getUIPrefs')).conversationSpeedOverrides)
        .toEqual({ [convB.id]: 'fast' })
      prefs = await apiCall<UIPrefsLike>(h.page, 'getUIPrefs')
      expect(prefs.conversationSpeedOverrides[convA.id], 'A 的覆盖应随会话删除').toBeUndefined()
      expect(prefs.conversationSpeedOverrides[convB.id], 'B 的覆盖不得被连带删除').toBe('fast')
      const disk = JSON.parse(readFileSync(join(h.dataDir, 'ui-prefs.json'), 'utf8')) as UIPrefsLike
      expect(disk.conversationSpeedOverrides).toEqual({ [convB.id]: 'fast' })
      const chip = await readSpeedChip(h.page)
      expect(chip.value, 'B 的界面选择不受影响').toBe('fast')
      expect(chip.effectiveText).toContain('FAST')
      expect(chip.effectiveText).toContain('会话覆盖')
      expect(await apiCall<Array<{ id: string }>>(h.page, 'listConversations')).toHaveLength(1)
    } finally {
      await h.close()
      await h.cleanup()
    }
  })
})

// ═══════════════════════════════════════════════════════════════════════════
// S3-30D：消息上的请求策略与实际服务档（真实 Electron + 本地假端点）
// ═══════════════════════════════════════════════════════════════════════════

const TIER_PROFILE_NAME = 'S3-30D 服务档夹具'

interface RunFactSnapshot {
  request: string | null
  actual: string | null
  observed: string | null
  rect: Rect
  fontSizes: number[]
  overflow: string[]
}

/** 读所有消息徽标：文本 / data-observed / 几何 / 字号 / 裁切 */
async function readRunFacts(page: Page): Promise<RunFactSnapshot[]> {
  return page.evaluate(() =>
    Array.from(document.querySelectorAll('.msg-run-facts')).map((el) => {
      const rect = el.getBoundingClientRect()
      const req = el.querySelector('[data-run-fact="request"]')
      const act = el.querySelector('[data-run-fact="actual"]')
      return {
        request: req ? (req.textContent ?? '').trim() : null,
        actual: act ? (act.textContent ?? '').trim() : null,
        observed: act ? act.getAttribute('data-observed') : null,
        rect: {
          x: Math.round(rect.x),
          y: Math.round(rect.y),
          w: Math.round(rect.width),
          h: Math.round(rect.height)
        },
        fontSizes: Array.from(el.querySelectorAll('.msg-run-fact')).map((n) =>
          parseFloat(getComputedStyle(n).fontSize)
        ),
        overflow: Array.from(el.querySelectorAll('.msg-run-fact'))
          .filter((n) => n.scrollWidth > n.clientWidth + 1)
          .map((n) => (n.textContent ?? '').trim())
      }
    })
  )
}

/** 主窗口缩放/尺寸（按 URL 认窗口身份，不取任意第一个窗口） */
async function setMainWindow(
  h: E2EApp,
  opts: { width?: number; height?: number; zoom?: number }
): Promise<void> {
  await h.app.evaluate(({ BrowserWindow }, o) => {
    const win = BrowserWindow.getAllWindows().find((w) => w.webContents.getURL().includes('index.html'))
    if (!win) throw new Error('主窗口未找到')
    if (o.width && o.height) win.setSize(o.width, o.height)
    if (o.zoom) win.webContents.setZoomFactor(o.zoom)
  }, opts)
  await h.page.waitForTimeout(300)
}

/** 服务档夹具：模型声明支持 priority；默认可普通或 FAST */
async function seedTierProfile(
  h: E2EApp,
  speedMode: 'normal' | 'fast',
  baseURL: string,
  apiKey: string
): Promise<{ id: string }> {
  const saved = await apiCall<{ id: string }>(h.page, 'saveModel', {
    name: TIER_PROFILE_NAME,
    providerType: 'openai-compatible',
    baseURL,
    stream: true,
    timeoutMs: 15_000,
    models: [
      {
        id: 's3d-model',
        model: 's3d-model',
        name: '服务档模型',
        speedMode,
        metadata: { serviceTiers: { official: { value: ['priority'], observedAt: SEED_TS } } }
      }
    ],
    apiKey
  })
  expect(saved.id, '保存服务档端点应回 id').toBeTruthy()
  await apiCall(h.page, 'setActiveModel', saved.id)
  await h.page.reload()
  await expect(h.page.locator('.sidebar')).toBeVisible({ timeout: 30_000 })
  return { id: saved.id }
}

interface TierServerHandle {
  srv: Server
  port: number
  requests: Array<{ body: string; hasTools: boolean }>
}

/** 本地假端点：按用户正文里的标记决定真实回报（standard / priority / 缺报 / 长容量名 / 失败 / 挂起） */
async function startTierServer(): Promise<TierServerHandle> {
  const requests: Array<{ body: string; hasTools: boolean }> = []
  const srv = createServer((req, res) => {
    let raw = ''
    req.on('data', (chunk: Buffer) => {
      raw += chunk.toString('utf8')
    })
    req.on('end', () => {
      let parsed: { tools?: unknown[] } | null = null
      try {
        parsed = JSON.parse(raw) as { tools?: unknown[] }
      } catch {
        parsed = null
      }
      const hasTools = Array.isArray(parsed?.tools) && parsed.tools.length > 0
      // 只认**最后一条用户消息**里的标记：历史正文会留在 body 里，按整包 includes 会把上一轮标记带进来
      const bodyMessages = Array.isArray((parsed as { messages?: unknown[] } | null)?.messages)
        ? ((parsed as { messages?: Array<{ role?: string; content?: unknown }> }).messages ?? [])
        : []
      const lastUser = [...bodyMessages].reverse().find((m) => m.role === 'user')?.content
      const marker = typeof lastUser === 'string' ? lastUser : JSON.stringify(lastUser ?? '')
      requests.push({ body: raw, hasTools })
      if (!hasTools) {
        res.writeHead(200, { 'content-type': 'text/event-stream' })
        res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: '服务档会话' } }] })}\n\n`)
        res.write(`data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: 'stop' }] })}\n\n`)
        res.end('data: [DONE]\n\n')
        return
      }
      if (marker.includes('S3D_FAIL')) {
        res.writeHead(500, { 'content-type': 'application/json' })
        res.end(JSON.stringify({ error: { message: '假端点失败' } }))
        return
      }
      res.writeHead(200, { 'content-type': 'text/event-stream' })
      res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: '回复' } }] })}\n\n`)
      if (raw.includes('S3D_HOLD')) return // 不结束：由界面「停止」中断
      const tier = marker.includes('S3D_LONG')
        ? 'vendor-extended-capacity-blue'
        : marker.includes('S3D_FAST')
          ? 'priority'
          : marker.includes('S3D_NORMAL')
            ? 'standard'
            : null
      setTimeout(() => {
        const frame: Record<string, unknown> = {
          choices: [],
          usage: { prompt_tokens: 11, completion_tokens: 3 }
        }
        if (tier) frame['service_tier'] = tier
        res.write(`data: ${JSON.stringify(frame)}\n\n`)
        res.write(`data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: 'stop' }] })}\n\n`)
        res.end('data: [DONE]\n\n')
      }, 90)
    })
  })
  srv.listen(0, '127.0.0.1')
  await once(srv, 'listening')
  return { srv, port: (srv.address() as AddressInfo).port, requests }
}

async function closeTierServer(handle: TierServerHandle | null): Promise<void> {
  if (!handle) return
  handle.srv.closeAllConnections()
  await new Promise<void>((resolve) => handle.srv.close(() => resolve()))
}

test.describe('S3-30D 请求策略与实际服务档：真实渲染与历史归属', () => {
  test('普通/优先/缺报/长容量名各按真实回值显示，历史不随会话切换改写，窄窗与缩放可见', async () => {
    const h = await launchApp()
    let server: TierServerHandle | null = null
    try {
      const encryptionAvailable = await h.app.evaluate(({ safeStorage }) =>
        safeStorage.isEncryptionAvailable()
      )
      test.skip(!encryptionAvailable, '本地假端点发送需要 safeStorage；仅跳本故事')
      server = await startTierServer()
      await seedTierProfile(
        h,
        'normal',
        `http://127.0.0.1:${server.port}/v1`,
        '{{SECRET_s3d_local_only}}'
      )

      // ① 普通：请求不带优先档，实际 standard
      await h.page.locator('.sidebar .new-task-btn').click()
      await expect(h.page.locator('.new-task')).toBeVisible()
      await expect(h.page.locator('.speed-scope'), '输入区必须标明这是下一轮的选择').toHaveText('下一轮')
      await h.page.locator('textarea.console-input').fill('S3D_NORMAL 第一轮')
      await h.page.locator('textarea.console-input').press('Enter')
      await expect(h.page.locator('.msg-assistant').last()).toContainText('回复', { timeout: 30_000 })
      await expect(h.page.locator('.msg-terminal[data-terminal-state="completed"]')).toHaveCount(1)

      let facts = await readRunFacts(h.page)
      expect(facts).toHaveLength(1)
      expect(facts[0].request).toBe('请求：普通')
      expect(facts[0].actual).toBe('实际：普通')
      expect(facts[0].observed).toBe('true')
      const convAMeta = (await apiCall<Array<{ id: string; title: string }>>(h.page, 'listConversations'))[0]!
      const convA = convAMeta.id
      const normalReq = server.requests.filter((r) => r.hasTools)[0]!
      expect(normalReq.body, '普通档不得请求优先服务档').not.toContain('"service_tier"')

      // ② 同会话改 FAST：下一轮请求带 priority，实际优先；第一轮徽标不被改写
      await h.page.locator('.speed-select').selectOption('fast')
      await waitSpeedOverride(h, convA, 'fast')
      await h.page.locator('textarea.console-input').fill('S3D_FAST 第二轮')
      await h.page.locator('textarea.console-input').press('Enter')
      await expect(h.page.locator('.msg-assistant')).toHaveCount(2, { timeout: 30_000 })
      await expect(h.page.locator('.msg-assistant').last()).toContainText('回复', { timeout: 30_000 })
      await expect(h.page.locator('.msg-terminal[data-terminal-state="completed"]')).toHaveCount(2, { timeout: 30_000 })

      facts = await readRunFacts(h.page)
      expect(facts).toHaveLength(2)
      expect(facts[0].request, '第一轮历史不得被当前 FAST 改写').toBe('请求：普通')
      expect(facts[0].actual).toBe('实际：普通')
      expect(facts[1].request).toBe('请求：FAST')
      expect(facts[1].actual).toBe('实际：优先')
      expect(facts[1].observed).toBe('true')
      const fastReq = server.requests.filter((r) => r.hasTools)[1]!
      expect(fastReq.body, 'FAST+supported 的请求必须携带 priority').toContain('"service_tier":"priority"')

      // ③ 缺报：实际未知；策略仍是冻结的 FAST
      await h.page.locator('textarea.console-input').fill('S3D_UNKNOWN 第三轮')
      await h.page.locator('textarea.console-input').press('Enter')
      await expect(h.page.locator('.msg-assistant')).toHaveCount(3, { timeout: 30_000 })
      await expect(h.page.locator('.msg-assistant').last()).toContainText('回复', { timeout: 30_000 })
      await expect(h.page.locator('.msg-terminal[data-terminal-state="completed"]')).toHaveCount(3, { timeout: 30_000 })
      facts = await readRunFacts(h.page)
      expect(facts[2].request).toBe('请求：FAST')
      expect(facts[2].actual).toBe('实际：未知')
      expect(facts[2].observed).toBe('false')

      // ④ 长容量名：原样有界展示，不裁切、不臆造枚举
      await h.page.locator('textarea.console-input').fill('S3D_LONG 第四轮')
      await h.page.locator('textarea.console-input').press('Enter')
      await expect(h.page.locator('.msg-assistant')).toHaveCount(4, { timeout: 30_000 })
      await expect(h.page.locator('.msg-assistant').last()).toContainText('回复', { timeout: 30_000 })
      await expect(h.page.locator('.msg-terminal[data-terminal-state="completed"]')).toHaveCount(4, { timeout: 30_000 })
      facts = await readRunFacts(h.page)
      expect(facts[3].actual).toContain('实际：vendor-extended')
      expect(facts[3].actual!.length, '长容量名必须截断到有界长度').toBeLessThanOrEqual(32)
      expect(facts[3].overflow, '长容量名不得在芯片内被裁切').toEqual([])

      // ⑤ 第二条会话：各显示各的事实；切回 A 后 A 的四个徽标原样
      const ws = await apiCall<{ path: string }>(h.page, 'getWorkspace')
      const convB = await apiCall<{ id: string }>(h.page, 'createConversation', {
        workspace: ws.path,
        model: 's3d-model',
        firstMessage: '会话B'
      })
      await h.page.reload()
      await openConversationByTitle(h.page, '会话B')
      await h.page.locator('.speed-select').selectOption('fast')
      await waitSpeedOverride(h, convB.id, 'fast')
      await h.page.locator('textarea.console-input').fill('S3D_FAST B轮')
      await h.page.locator('textarea.console-input').press('Enter')
      await expect(h.page.locator('.msg-assistant')).toHaveCount(1, { timeout: 30_000 })
      await expect(h.page.locator('.msg-assistant').last()).toContainText('回复', { timeout: 30_000 })
      await expect(h.page.locator('.msg-terminal[data-terminal-state="completed"]')).toHaveCount(1, { timeout: 30_000 })
      const bFacts = await readRunFacts(h.page)
      expect(bFacts).toHaveLength(1)
      expect(bFacts[0].request).toBe('请求：FAST')
      expect(bFacts[0].actual).toBe('实际：优先')

      await openConversationByTitle(h.page, convAMeta.title)
      const aFacts = await readRunFacts(h.page)
      expect(aFacts.map((f) => f.actual)).toEqual([
        '实际：普通',
        '实际：优先',
        '实际：未知',
        facts[3].actual
      ])
      expect(aFacts.map((f) => f.request)).toEqual(['请求：普通', '请求：FAST', '请求：FAST', '请求：FAST'])

      // ⑥ 几何 / 字号 / 可见性 / 键盘
      for (const f of aFacts) {
        expect(f.rect.w, '徽标必须有真实宽度').toBeGreaterThan(0)
        expect(f.rect.h, '徽标必须有真实高度').toBeGreaterThan(0)
        expect(Math.min(...f.fontSizes), '徽标字号 ≥ 10.5px').toBeGreaterThanOrEqual(10.5)
        expect(f.overflow).toEqual([])
      }
      const chipText = aFacts.map((f) => `${f.request ?? ''}${f.actual ?? ''}`).join('')
      expect(chipText).not.toContain('requestId')
      expect(chipText).not.toMatch(/[0-9a-f]{8}-[0-9a-f]{4}-/i)
      await h.page.locator('.speed-select').focus()
      expect(
        await h.page.evaluate(() => document.activeElement?.className ?? ''),
        '速度选择器必须可用键盘聚焦'
      ).toContain('speed-select')

      // ⑦ 窄窗 + 125% / 150% 缩放：仍可见、不横向溢出
      await h.page.screenshot({ path: join(SHOT_DIR, 's3d-run-facts.png') })
      await setMainWindow(h, { width: 900, height: 700, zoom: 1.25 })
      let zoomFacts = await readRunFacts(h.page)
      for (const f of zoomFacts) {
        expect(f.rect.w).toBeGreaterThan(0)
        expect(f.overflow).toEqual([])
      }
      const actionsOverflow = await h.page.evaluate(
        () => Array.from(document.querySelectorAll('.msg-actions')).map((n) => n.scrollWidth - n.clientWidth)
      )
      expect(Math.max(...actionsOverflow), '窄窗下操作条不得横向溢出').toBeLessThanOrEqual(2)
      await h.page.screenshot({ path: join(SHOT_DIR, 's3d-run-facts-narrow.png') })
      await setMainWindow(h, { zoom: 1.5 })
      zoomFacts = await readRunFacts(h.page)
      for (const f of zoomFacts) {
        expect(f.rect.w).toBeGreaterThan(0)
        expect(f.overflow).toEqual([])
      }
      await setMainWindow(h, { width: 1280, height: 900, zoom: 1 })
    } finally {
      await closeTierServer(server)
      await h.close()
      await h.cleanup()
    }
  })

  test('失败与取消：冻结策略与未知实际仍显示；重启后历史徽标读回一致', async () => {
    const first = await launchApp()
    let current: E2EApp | null = first
    let server: TierServerHandle | null = null
    try {
      const encryptionAvailable = await first.app.evaluate(({ safeStorage }) =>
        safeStorage.isEncryptionAvailable()
      )
      test.skip(!encryptionAvailable, '本地假端点发送需要 safeStorage；仅跳本故事')
      server = await startTierServer()
      await seedTierProfile(first, 'fast', `http://127.0.0.1:${server.port}/v1`, '{{SECRET_s3d_local_only}}')

      // ① 零 chunk 失败：冻结策略仍显示，实际未知
      await first.page.locator('.sidebar .new-task-btn').click()
      await expect(first.page.locator('.new-task')).toBeVisible()
      await first.page.locator('textarea.console-input').fill('S3D_FAIL 失败轮')
      await first.page.locator('textarea.console-input').press('Enter')
      await expect(first.page.locator('.msg-terminal[data-terminal-state="failed"]')).toHaveCount(1, {
        timeout: 30_000
      })
      let facts = await readRunFacts(first.page)
      expect(facts).toHaveLength(1)
      expect(facts[0].request).toBe('请求：FAST')
      expect(facts[0].actual).toBe('实际：未知')
      expect(facts[0].observed).toBe('false')
      const convMeta = (await apiCall<Array<{ id: string; title: string }>>(first.page, 'listConversations'))[0]!
      const conv = convMeta.id

      // ② 挂起后点停止：取消终态 + 同一份冻结策略；实际未知
      await first.page.locator('textarea.console-input').fill('S3D_HOLD 取消轮')
      await first.page.locator('textarea.console-input').press('Enter')
      await expect(first.page.locator('.send-btn.stopping')).toBeVisible({ timeout: 15_000 })
      await first.page.locator('.send-btn.stopping').click()
      await expect(first.page.locator('.msg-terminal[data-terminal-state="cancelled"]')).toHaveCount(1, {
        timeout: 30_000
      })
      facts = await readRunFacts(first.page)
      expect(facts).toHaveLength(2)
      expect(facts[1].request).toBe('请求：FAST')
      expect(facts[1].actual).toBe('实际：未知')

      // ③ 重启：历史徽标从存档读回，成功与失败/取消各自保留
      const dataDir = first.dataDir
      await first.close()
      current = null
      current = await launchApp({ reuseDataDir: dataDir })
      await openConversationByTitle(current.page, convMeta.title)
      facts = await readRunFacts(current.page)
      expect(facts).toHaveLength(2)
      expect(facts[0].request).toBe('请求：FAST')
      expect(facts[0].actual).toBe('实际：未知')
      expect(facts[1].request).toBe('请求：FAST')
      expect(facts[1].actual).toBe('实际：未知')
      expect(conv).toBeTruthy()
    } finally {
      if (current) await current.close()
      await closeTierServer(server)
      await first.cleanup()
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
      await seedSpeedProfile(
        h,
        [{ id: 's3v40-fail', model: 's3v40-fail-model', name: '失败模型', speedMode: 'normal' }],
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
      await seedSpeedProfile(
        h,
        [{ id: 's3v40-offline', model: 's3v40-offline-model', name: '断网模型', speedMode: 'normal' }],
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

  test('FAST 开启后同一会话连续两轮：调用次数不增加，正文与终态不被重置', async () => {
    const h = await launchApp()
    let server: TierServerHandle | null = null
    try {
      const encryptionAvailable = await h.app.evaluate(({ safeStorage }) =>
        safeStorage.isEncryptionAvailable()
      )
      test.skip(!encryptionAvailable, '本地假端点发送需要 safeStorage；仅跳本故事')
      server = await startTierServer()
      await seedTierProfile(
        h,
        'fast',
        `http://127.0.0.1:${server.port}/v1`,
        '{{SECRET_s3v40_fast_local}}'
      )
      await h.page.locator('.sidebar .new-task-btn').click()
      await expect(h.page.locator('.new-task')).toBeVisible()

      await h.page.locator('textarea.console-input').fill('S3D_FAST S3V40_ROUND1')
      await h.page.locator('textarea.console-input').press('Enter')
      await expect(h.page.locator('.msg-assistant')).toHaveCount(1, { timeout: 30_000 })
      await expect(h.page.locator('.msg-terminal[data-terminal-state="completed"]')).toHaveCount(1, {
        timeout: 30_000
      })
      const firstFacts = await readRunFacts(h.page)
      expect(firstFacts[0].request, '请求策略应显示 FAST').toBe('请求：FAST')
      expect(firstFacts[0].actual, '实际档位只能来自厂商真实回报').toBe('实际：优先')
      const chipText = await h.page.locator('.speed-chip').innerText()
      expect(chipText).toContain('FAST')
      expect(chipText, '速度控件不得把策略意图写成已加速').not.toMatch(/已加速|已启用/)

      const convs = await apiCall<Array<{ id: string }>>(h.page, 'listConversations')
      expect(convs.length).toBeGreaterThanOrEqual(1)
      const conversationId = convs[0].id
      const firstSaved = await apiCall<{
        messages: Array<{ role: string; content: string; terminal?: { state?: string } }>
        usage?: { completionTokens?: number }
      }>(h.page, 'getConversation', conversationId)
      const firstAssistants = firstSaved.messages.filter((m) => m.role === 'assistant')
      expect(firstAssistants).toHaveLength(1)
      expect(firstAssistants[0].content).toContain('回复')
      expect(firstAssistants[0].terminal?.state).toBe('completed')
      expect(firstSaved.usage?.completionTokens ?? 0, '第一轮用量必须真实上报').toBeGreaterThan(0)
      expect(server.requests.filter((r) => r.hasTools), '第一轮只应有一个模型请求').toHaveLength(1)

      await h.page.locator('textarea.console-input').fill('S3D_FAST S3V40_ROUND2')
      await h.page.locator('textarea.console-input').press('Enter')
      await expect(h.page.locator('.msg-assistant')).toHaveCount(2, { timeout: 30_000 })
      await expect(h.page.locator('.msg-terminal[data-terminal-state="completed"]')).toHaveCount(2, {
        timeout: 30_000
      })

      const toolRequests = server.requests.filter((r) => r.hasTools)
      expect(toolRequests, '两轮应只新增两次模型调用，不得因并行读取重复请求').toHaveLength(2)
      expect(toolRequests[0].body, '第一轮 FAST 必须携带 priority').toContain(
        '"service_tier":"priority"'
      )
      expect(toolRequests[1].body, '第二轮 FAST 必须携带 priority').toContain(
        '"service_tier":"priority"'
      )

      const secondSaved = await apiCall<{
        messages: Array<{ role: string; content: string; terminal?: { state?: string } }>
        usage?: { completionTokens?: number }
      }>(h.page, 'getConversation', conversationId)
      const assistants = secondSaved.messages.filter((m) => m.role === 'assistant')
      expect(assistants, '两轮应保留两条助手消息').toHaveLength(2)
      expect(assistants[0].content, '第一轮正文不得被第二轮重置').toContain('回复')
      expect(assistants[0].terminal?.state, '第一轮终态不得被第二轮重置').toBe('completed')
      expect(assistants[1].terminal?.state, '第二轮终态应为 completed').toBe('completed')
      expect(
        secondSaved.usage?.completionTokens ?? 0,
        '两轮用量应累计，不得被重置'
      ).toBeGreaterThan(firstSaved.usage?.completionTokens ?? 0)
    } finally {
      await closeTierServer(server)
      await h.close()
      await h.cleanup()
    }
  })
})
