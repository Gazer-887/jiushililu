/**
 * 系统字体枚举（plan7 批 F3）—— 主进程侧：读系统，返回 family 名列表。
 *
 * 为什么必须在主进程做（plan7 原话）：渲染端 `document.fonts` 只有**已加载**的字体，
 * 枚举全量只能走系统层 —— Windows 读注册表，其余平台暂不支持（返回空 + 界面说明原因，
 * **不做假下拉框**：列不出字体就明说，不给一个"选了没反应"的选择器）。
 *
 * ⚠️ 只用 `reg query`（系统自带）而不是引入注册表原生模块：规避清单第一条就是
 *    "原生编译是高频翻车点"（AGENTS.md），为一个只读查询不值当。
 */

import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { parseFontRegistryOutput, type SystemFontsResult } from '@shared/font-names'

const execFileP = promisify(execFile)

const FONT_REG_KEY = 'HKLM\\SOFTWARE\\Microsoft\\Windows NT\\CurrentVersion\\Fonts'

/** 进程内缓存：字体列表在应用运行期间基本不变，设置页每次打开都跑一遍 reg 是浪费 */
let cache: SystemFontsResult | null = null

export async function listSystemFonts(): Promise<SystemFontsResult> {
  if (cache) return cache
  if (process.platform !== 'win32') {
    cache = { ok: false, fonts: [], message: '当前系统暂不支持字体枚举（仅 Windows 提供）。仍可手动输入字体名。' }
    return cache
  }
  try {
    const { stdout } = await execFileP('reg', ['query', FONT_REG_KEY], { maxBuffer: 4 * 1024 * 1024 })
    const fonts = parseFontRegistryOutput(stdout)
    cache =
      fonts.length > 0
        ? { ok: true, fonts, message: null }
        : { ok: false, fonts: [], message: '注册表里没有读到任何字体（这不正常，请反馈日志）。' }
  } catch (err) {
    // 读失败**不抛**：设置页还开着，字体下拉显示原因即可 —— 别让一个枚举功能把设置页打挂
    cache = {
      ok: false,
      fonts: [],
      message: `字体枚举失败：${err instanceof Error ? err.message : String(err)}`
    }
  }
  return cache
}
