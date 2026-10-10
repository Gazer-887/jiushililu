// 复用electron-store的Conf后端，所有设置落在临时settings.json，禁止读真实用户配置。
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, dirname, join, resolve } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { TokenSaverTier } from '@shared/token-tier'

const fixture = vi.hoisted(() => ({ root: '' }))
vi.mock('electron', () => ({ safeStorage: { isEncryptionAvailable: () => false } }))
vi.mock('electron-store', async () => {
  const { default: Conf } = await import('conf')
  return { default: class extends Conf {
    constructor(options: { name: string }) {
      if (!fixture.root) throw new Error('必须先指定隔离数据根')
      super({ cwd: fixture.root, configName: options.name, projectName: 'isolated-settings', projectVersion: '0.0.0' })
    }
  } }
})
const tiers: TokenSaverTier[] = ['light', 'balanced', 'rich', 'ultimate']
beforeEach(() => { fixture.root = mkdtempSync(join(tmpdir(), 'jsl-settings-')); vi.resetModules() })
afterEach(() => {
  expect(resolve(dirname(fixture.root))).toBe(resolve(tmpdir()))
  expect(basename(fixture.root).startsWith('jsl-settings-')).toBe(true)
  rmSync(fixture.root, { recursive: true, force: true })
  fixture.root = ''
})
const disk = (): Record<string, unknown> => {
  const path = join(fixture.root, 'settings.json')
  return existsSync(path) ? JSON.parse(readFileSync(path, 'utf8')) : {}
}
describe('自动记忆的实际settings落点', () => {
  it('全缺省回落平衡档且开，不把默认写成显式设置', async () => {
    const settings = await import('@main/store/settings')
    expect(settings.getTokenTier()).toBe('balanced')
    expect(settings.getAutoMemoryEnabled()).toBe(true)
    expect(disk()).not.toHaveProperty('autoMemoryEnabled')
  })
  it.each(tiers)('未设值的%s档默认，重载后相同且不写默认值', async (tier) => {
    let settings = await import('@main/store/settings')
    expect(settings.setTokenTier(tier)).toBe(tier)
    expect(settings.getAutoMemoryEnabled()).toBe(tier !== 'light')
    expect(disk()).toEqual({ tokenSaverTier: tier })
    vi.resetModules(); settings = await import('@main/store/settings')
    expect(settings.getAutoMemoryEnabled()).toBe(tier !== 'light')
    expect(disk()).not.toHaveProperty('autoMemoryEnabled')
  })
  it.each([true, false])('显式%s保存、跨四档、重载后仍优先', async (enabled) => {
    let settings = await import('@main/store/settings')
    expect(settings.setAutoMemoryEnabled(enabled)).toBe(enabled)
    for (const tier of tiers) {
      settings.setTokenTier(tier)
      expect(settings.getAutoMemoryEnabled()).toBe(enabled)
      expect(disk()).toEqual({ autoMemoryEnabled: enabled, tokenSaverTier: tier })
      vi.resetModules(); settings = await import('@main/store/settings')
      expect(settings.getAutoMemoryEnabled()).toBe(enabled)
      expect(settings.getTokenTier()).toBe(tier)
    }
  })
})
