import { zh } from './zh'

/**
 * 文案表的形状类型：`zh` 的键结构 + 值一律放宽成 `string`。
 * `zh` 自己是 `as const`（值被钉成字面量），直接拿 `typeof zh` 当 `en` 的类型会要求两边**一字不差**，
 * 所以这里把值剥成 string、只保留键的形状 —— 缺键 / 多键仍然报错，这正是 plan52 D2 要的编译期把关。
 */
export type Messages = { [K in keyof typeof zh]: DeepString<(typeof zh)[K]> }
type DeepString<T> = T extends string ? string : { [K in keyof T]: DeepString<T[K]> }

export { zh } from './zh'
export { en } from './en'

/** 默认命名空间：`t('newTask')` 不写前缀时走它 */
export const NAMESPACE_DEFAULT = 'common'
/** 命名空间 = `zh` 的第一层键（加一屏文案就多个键，不用改装配代码） */
export const NAMESPACES = Object.keys(zh) as Array<keyof typeof zh>
