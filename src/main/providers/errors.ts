// 把各厂商的 HTTP 错误翻译成人话。
// 常见坑的对照说明见 DIARY/专题-模型接入配置.md 的踩坑表。

export class ProviderError extends Error {
  readonly status?: number

  constructor(message: string, status?: number) {
    super(message)
    this.name = 'ProviderError'
    this.status = status
  }
}

export function mapHttpError(status: number, body: string): string {
  const detail = body.slice(0, 200)
  switch (status) {
    case 401:
      return '认证失败（401）：API Key 无效或未生效，请检查是否复制完整'
    case 403:
      return '无权限（403）：Key 权限不足或已被禁用'
    case 404:
      return '接口或模型不存在（404）：优先检查 baseURL 的 /v1 拼接与模型名拼写'
    case 429:
      return '请求过频或额度不足（429）：稍后重试或检查账户余额'
    case 500:
    case 502:
    case 503:
      return `服务端异常（HTTP ${status}）：厂商侧问题，稍后重试`
    default:
      return `请求失败（HTTP ${status}）：${detail}`
  }
}

export function isAbortError(err: unknown): boolean {
  return err instanceof Error && err.name === 'AbortError'
}

/**
 * 「拉取模型列表」三档人话（plan47 S2）。同一状态码在列表场景语义不同：
 * 404 = 端点不提供列表接口（不是模型名拼错），必须给手填兜底；
 * 401/403 指向 Key 类型 —— 按量与套餐常是两把 Key（实证见 DIARY/专题-模型接入配置.md）。
 */
export function mapListModelsError(status: number): string {
  if (status === 404 || status === 405 || status === 501) {
    return `此端点不提供模型列表（HTTP ${status}）：请手动填写模型 ID`
  }
  if (status === 401 || status === 403) {
    return `API Key 被拒绝（HTTP ${status}）：确认 Key 类型与通道匹配 —— 按量计费与套餐计划往往是两把不同的 Key`
  }
  if (status === 429) {
    return '请求过频或额度不足（429）：稍后重试，或检查账户余额'
  }
  return `拉取模型列表失败（HTTP ${status}）：请核对接口地址与 Key`
}

/** 网络层失败（连接拒绝 / DNS 解析不了；fetch 抛 TypeError）：三档里的第三档 */
export const LIST_MODELS_NETWORK_ERROR = '连不上该端点：请检查网络与代理设置，本地服务请确认其已启动'
