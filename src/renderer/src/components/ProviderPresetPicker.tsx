import { useMemo } from 'react'
import {
  listProviderPresets,
  listForbiddenPresets,
  OPEN_CODE_CONSOLE_NOTE,
  type AuthDefault,
  type ProviderPreset,
  type PresetProtocol,
  type RequestIdentityMode
} from '@shared/provider-presets'

export interface PresetSelection {
  presetId: string
  presetName: string
  protocol: PresetProtocol
  baseURL: string
  requestIdentity: RequestIdentityMode
  authDefault: AuthDefault
  helpUrl: string
  notes: string[]
}

/** 模板帮助链接：外链一律新窗口 + noreferrer noopener；空 helpUrl 不渲染 */
function PresetHelpLink({ url }: { url: string }): JSX.Element | null {
  if (!url) return null
  return (
    <a className="preset-help-link" href={url} target="_blank" rel="noreferrer noopener">
      官方文档
    </a>
  )
}

interface PickerProps {
  onSelect: (selection: PresetSelection) => void
  onCancel: () => void
}

const CATEGORY_LABEL: Record<string, string> = {
  'regular-api': '普通 API / 聚合',
  'subscription': '订阅',
  'custom': '自定义',
  'local-gateway': '本地网关'
}

/**
 * S3-10A：模板选择器——展示冻结名单与禁用五项，只回调选中结果；
 * 实际保存/草稿管理由 SettingsView.save() 走既有 saveModel。
 * 本组件零网络调用、零配置写入。
 */
export default function ProviderPresetPicker({ onSelect, onCancel }: PickerProps): JSX.Element {
  const presets = useMemo(() => listProviderPresets(), [])
  const forbidden = useMemo(() => listForbiddenPresets(), [])
  const grouped = useMemo(() => {
    const map = new Map<string, ProviderPreset[]>()
    for (const p of presets) {
      const list = map.get(p.category) ?? []
      list.push(p)
      map.set(p.category, list)
    }
    return map
  }, [presets])

  return (
    <div className="preset-picker" role="dialog" aria-label="选择供应商模板">
      <h3>选择供应商模板</h3>
      <p className="hint preset-picker-note">{OPEN_CODE_CONSOLE_NOTE}</p>
      {[...grouped.entries()].map(([cat, list]) => (
        <fieldset key={cat} className="preset-group">
          <legend>{CATEGORY_LABEL[cat] ?? cat}</legend>
          {list.map((p) =>
            p.faces.length > 1 ? (
              <div key={p.id} className="preset-item preset-dual">
                <span className="preset-name">{p.displayName}</span>
                <PresetHelpLink url={p.helpUrl} />
                {(p.notes ?? []).map((n, i) => <span key={'pn'+i} className="preset-note">{n}</span>)}
                {p.faces.map((f) => (
                  <button
                    key={f.protocol}
                    type="button"
                    className="btn-secondary preset-face-btn"
                    onClick={() =>
                      onSelect({
                        presetId: p.id, presetName: p.displayName, protocol: f.protocol,
                        baseURL: f.baseUrlTemplate, requestIdentity: p.requestIdentity,
                        authDefault: p.authDefault[f.protocol] ?? 'unknown', helpUrl: p.helpUrl,
                        notes: f.notes ?? []
                      })
                    }
                  >
                    {f.protocol === 'openai-compatible' ? 'OpenAI 兼容' : 'Anthropic'}
                    {(f.notes ?? []).length > 0 && <span className="preset-note">{(f.notes ?? [])[0]}</span>}
                  </button>
                ))}
              </div>
            ) : (
              <div key={p.id} className="preset-item">
                <span className="preset-notes-group">
                  {(p.notes ?? []).map((n, i) => <span key={'pn'+i} className="preset-note">{n}</span>)}
                  {(p.faces[0].notes ?? []).map((n, i) => <span key={'fn'+i} className="preset-note">{n}</span>)}
                </span>
                <button
                  type="button"
                  className="btn-secondary preset-btn"
                  onClick={() =>
                    onSelect({
                      presetId: p.id, presetName: p.displayName, protocol: p.faces[0].protocol,
                      baseURL: p.faces[0].baseUrlTemplate, requestIdentity: p.requestIdentity,
                      authDefault: p.authDefault[p.faces[0].protocol] ?? 'unknown', helpUrl: p.helpUrl,
                      notes: [...(p.notes ?? []), ...(p.faces[0].notes ?? [])]
                    })
                  }
                >
                  {p.displayName}
                </button>
                <PresetHelpLink url={p.helpUrl} />
              </div>
            )
          )}
        </fieldset>
      ))}
      <fieldset className="preset-group preset-forbidden">
        <legend>禁用（不可选择）</legend>
        {forbidden.map((f) => (
          <div key={f.id} className="preset-item preset-forbidden-item" title={f.officialReason}>
            <span className="preset-name preset-forbidden-name">{f.displayName}</span>
            <span className="preset-forbidden-reason">{f.officialReason}</span>
            <PresetHelpLink url={f.helpUrl} />
          </div>
        ))}
      </fieldset>
      <button type="button" className="btn-secondary preset-cancel" onClick={onCancel}>
        返回
      </button>
    </div>
  )
}
