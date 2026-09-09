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
