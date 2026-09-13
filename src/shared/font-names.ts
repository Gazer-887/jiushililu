/**
 * 系统字体枚举的**解析层**（plan7 批 F3）—— 纯逻辑：不碰 IO、不认识平台，可被单测直接覆盖。
 *
 * 为什么要单独一层：`document.fonts` **拿不到全部系统字体**（只有已加载的），枚举必须靠主进程读
 * 注册表（plan7 原话）—— 而 `reg query` 的输出是给人看的表格，直接用等于把格式假设散在业务代码里。
 * 收到这里：一条测试一个格式坑，主进程只管"跑命令、喂数据"。
 *
 * Windows 注册表值名示例（`HKLM\...\CurrentVersion\Fonts`）：
 *   `Microsoft YaHei & Microsoft YaHei UI (TrueType)`   ← 连体家族，`&` 分隔
 *   `SimSun & NSimSun & SimSun-ExtB (TrueType)`
 *   `Arial Bold (TrueType)`                              ← 同一家族的样式变体也占一条
 *   `Segoe UI Variable (TrueType)`
 */

/** 去掉注册表值名尾部的文件类型标注 */
const TYPE_SUFFIX = /\s*\((TrueType|OpenType|Bitmap|Vector)\)$/i

/** 同一家族的样式变体（注册表把 "Arial Bold" 单独立一条；家族名其实还是 Arial） */
const STYLE_SUFFIX = /\s+(Bold Italic|Bold|Italic|Regular)$/i

/**
 * 字体枚举的 IPC 结果（plan7 批 F3）。
 * ⚠️ 类型必须住在 shared：它跨主/渲染两进程传递；列不出字体就给 `ok:false` + 人话 `message`，
 *    **不做假下拉框** —— 渲染端拿不到列表时显示原因并退化为手动输入。
 */
export interface SystemFontsResult {
  ok: boolean
  fonts: string[]
  /** ok = false 时给人看的理由（比如"当前系统暂不支持枚举"） */
  message: string | null
}

/**
 * 把 `reg query` 的输出解析成**去重的 family 名列表**（已排序）。
 * ⚠️ 设计取舍：**不剥** "Arial Black" / "Segoe UI Variable" 这类名字 —— 它们是**独立的 family**，
 *    CSS 里写 "Arial" 调不出它们。只剥真正的样式词（Bold/Italic/Regular），宁可多列几条
 *    也不给用户一个选了没反应的名字。
 */
export function parseFontRegistryOutput(output: string): string[] {
  const names = new Set<string>()
  for (const rawLine of output.split(/\r?\n/)) {
    const line = rawLine.trim()
    // reg query 的数据行形如：`值名    REG_SZ    数据`。
    // ⚠️ 真机输出（2026-09-14 实测 Win11）：值名**不带引号**（`Arial (TrueType)    REG_SZ    arial.ttf`），
    //    且值名可以含空格 —— 所以只能"截到第一个 REG_SZ 为止"当值名，不能按引号或按单词切。
    const m = /^(.+?)\s+REG_SZ\s+/.exec(line)
    if (!m) continue
    // 兼容带引号的变体（不同 Windows 版本行为有差异）：有引号剥引号，没引号原样
    const valueName = m[1]!.replace(/^"(.*)"$/, '$1').trim()
    const name = valueName.replace(TYPE_SUFFIX, '').trim()
    if (name.length === 0) continue
    // 连体家族（`A & B & C`）拆开：它们各自都是合法的 family 名，用户在别的软件里见到的名字是哪个就给哪个
    for (const part of name.split(' & ')) {
      const family = part.replace(STYLE_SUFFIX, '').trim()
      if (family.length > 0) names.add(family)
    }
  }
  return [...names].sort((a, b) => a.localeCompare(b, 'zh-Hans-CN'))
}
