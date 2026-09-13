// 搜索请求的**纯逻辑**：把"用户/模型给的参数"翻译成一份可执行规格 + 一份人话说明。
//
// 为什么要这一层：`search_files` 以前是"朴素扫描器 + 大小写不敏感 + 无正则"，而计划里写的是 L0 = ripgrep。
// 口径要对齐（plan3/plan4 的 L0），但**不能让脚本层拼命令行** —— 拼错一个引号就会静默搜错东西，
// 而这类错误表现为"搜不到"，看起来像"项目里没有"，是最难查的一种。
// 于是：规格生成放这里（纯函数、可单测），执行放 `main/retrieval/`。

/** 搜索模式：字面量（默认）还是正则 */
export type SearchMode = 'literal' | 'regex'

export interface SearchQueryInput {
  /** 模型给的原文 */
  query: string
  /** true = 按正则解释（默认 false —— 模型给的多半是"要找的那串字符"） */
  regex?: boolean
  /** true = 区分大小写（默认 false） */
  caseSensitive?: boolean
}

export interface SearchSpec {
  /** 真正要匹配的串（与输入相同；保留字段是为了将来做转义归一） */
  pattern: string
  mode: SearchMode
  caseSensitive: boolean
  /** 字面量模式下必须**先转义**再交给正则引擎 —— 否则 `a.b` 会把 `.` 当通配符 */
  escapeForRegex: boolean
  /** 给模型看的人话说明（进工具返回值，让它知道自己是按什么口径搜的） */
  describe: string
}

export class SearchQueryError extends Error {}

/**
 * 把 `query` 编译成可执行规格。
 *
 * ⚠️ 正则模式**必须在这里试编译一次**：坏正则（`(`、`[a-`）如果留到执行期才抛，
 * 不同执行后端（ripgrep / JS RegExp）会给出**不同的报错**，甚至一个接受一个拒绝 ——
 * 那就成了"同一个查询两次结果不同"。先在这里用 JS RegExp 验一遍，统一口径。
 */
export function buildSearchSpec(input: SearchQueryInput): SearchSpec {
  const raw = input.query
  if (typeof raw !== 'string' || raw.length === 0) {
    throw new SearchQueryError('query 不能为空')
  }
  if (raw.length > 500) {
    throw new SearchQueryError('query 过长（上限 500 字符）—— 请缩短要搜索的内容')
  }
  // 换行会让"以行为单位"的匹配失去意义，且命令行投影时极易出错
  if (/[\r\n]/.test(raw)) {
    throw new SearchQueryError('query 不能包含换行 —— 请去掉换行后重试')
  }

  const mode: SearchMode = input.regex === true ? 'regex' : 'literal'
  const caseSensitive = input.caseSensitive === true

  if (mode === 'regex') {
    try {
      new RegExp(raw, caseSensitive ? '' : 'i')
    } catch (err) {
      throw new SearchQueryError(`正则表达式无效：${err instanceof Error ? err.message : String(err)}`)
    }
  }

  const parts: string[] = []
  parts.push(mode === 'regex' ? '按正则匹配' : '按字面量匹配')
  parts.push(caseSensitive ? '区分大小写' : '不区分大小写')
  const describe = parts.join('、')

  return {
    pattern: raw,
    mode,
    caseSensitive,
    escapeForRegex: mode === 'literal',
    describe
  }
}

/**
 * 字面量 → 正则源码。**只转义正则元字符**，`*` `?` 这类在"字面量"语义下就是普通字符
 * （模型搜 `TODO*` 时想要的几乎总是"含这个星号的文本"，而不是"若干个 O"）。
 */
export function literalToRegexSource(literal: string): string {
  return literal.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

/** 规格 → 正则源码（不论哪种模式，最终都能变成一个 JS RegExp，供降级扫描器使用） */
export function specToRegexSource(spec: SearchSpec): string {
  return spec.escapeForRegex ? literalToRegexSource(spec.pattern) : spec.pattern
}

/** 规格 → JS RegExp（降级扫描器与单测共用；正则已在 `buildSearchSpec` 验过，这里不会抛） */
export function specToRegExp(spec: SearchSpec): RegExp {
  return new RegExp(specToRegexSource(spec), spec.caseSensitive ? '' : 'i')
}
