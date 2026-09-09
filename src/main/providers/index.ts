import type { ProviderType } from '@shared/ipc'
import { OpenAICompatibleProvider } from './openai'
import { AnthropicProvider } from './anthropic'
import type { IProvider } from './types'

// Provider 抽象的工厂入口：上层只认 IProvider，厂商方言（参数名、SSE 格式、认证头）收在适配器里。
// 新增厂商 = 加一个适配器文件 + 在这里注册一行，不改业务代码。

export function createProvider(type: ProviderType): IProvider {
  switch (type) {
    case 'anthropic':
      return new AnthropicProvider()
    case 'openai-compatible':
    default:
      return new OpenAICompatibleProvider()
  }
}

export { ProviderError } from './errors'
