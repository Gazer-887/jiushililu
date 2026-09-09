// API Key 掩码 —— 纯函数单独放一个文件，方便单元测试（不引入 electron）。

export function maskKey(key: string): string {
  if (!key) return ''
  if (key.length <= 8) return '****'
  return `${key.slice(0, 3)}****${key.slice(-4)}`
}
