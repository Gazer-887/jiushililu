import type { Session, WebContents } from 'electron'

/** 比较完整应用入口，只忽略应用路由hash；不将所有file://或同源页面视为可信。 */
function pageUrl(value: unknown): string | null {
  if (typeof value !== 'string' || !value) return null
  try {
    const url = new URL(value)
    url.hash = ''
    return url.href
  } catch {
    return null
  }
}

/** 实际session安装入口。身份、frame和语音资格每次读取，不授予整个session音频权限。 */
export function installMediaPermissions(
  session: Pick<Session, 'setPermissionRequestHandler' | 'setPermissionCheckHandler'>,
  getMain: () => WebContents | null,
  rendererUrl: string,
  voiceReady: () => boolean
): void {
  const expected = pageUrl(rendererUrl)
  function trusted(wc: WebContents | null, details: { requestingUrl?: string; isMainFrame?: boolean }): boolean {
    try {
      const main = getMain()
      return expected !== null && wc !== null && wc === main && !wc.isDestroyed() &&
        details.isMainFrame === true && pageUrl(wc.getURL()) === expected &&
        pageUrl(details.requestingUrl) === expected && voiceReady()
    } catch {
      return false
    }
  }
  session.setPermissionRequestHandler((wc, permission, callback, details) => {
    const types = 'mediaTypes' in details ? details.mediaTypes : undefined
    callback(permission === 'media' && Array.isArray(types) && types.length > 0 &&
      types.every((type) => type === 'audio') && trusted(wc, details))
  })
  session.setPermissionCheckHandler((wc, permission, origin, details) => {
    const expectedOrigin = expected ? new URL(expected).origin : null
    const originAllowed = expected?.startsWith('file:')
      ? origin === 'file://' || origin === 'null'
      : origin === expectedOrigin
    return permission === 'media' && details.mediaType === 'audio' && originAllowed && trusted(wc, details)
  })
}
