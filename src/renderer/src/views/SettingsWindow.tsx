import { useEffect } from 'react'
import SettingsView from './SettingsView'
import { useAppStore } from '../store'

/*
 * 设置**独立窗口**的外壳（2026-09-13 用户定案）。
 *
 * 形态对齐用户给的 WorkBuddy 参考图：浮在主窗口之上的独立窗口 ——
 * 顶部一行「设置」标题 + 右上角关闭按钮，下面才是「左栏分区 + 右内容」。
 *
 * ⚠️ **为什么标题栏要自己画**：主进程建窗口时用的是系统默认边框（`frame: true`），
 *    系统标题栏已经带了关闭按钮。这里再画一条"设置 / ×"是为了**内容区内的视觉锚点** ——
 *    参考图里那条标题栏与设置内容是一体的（设置窗口没有菜单栏、没有地址栏，需要一句话说清"这是什么"）。
 *    故本 shell **不隐藏系统边框**（藏了就要自己实现拖动/缩放/最小化，不值得），
 *    只在其下加一条轻量标题行。
 *
 * ⚠️ 这里**不挂流式订阅**（那是 App 层的事，设置窗口没有会话）。
 *    但**必须挂设置变更订阅**：设置窗口自己也是"会改设置的那个窗口"，
 *    主窗口改了设置（或将来另一个入口改了）它要跟着刷新。
 */
export default function SettingsWindow(): JSX.Element {
  const loadSettings = useAppStore((s) => s.loadSettings)
  const loadUIPrefs = useAppStore((s) => s.loadUIPrefs)
  const subscribeSettingsChanged = useAppStore((s) => s.subscribeSettingsChanged)

  useEffect(() => {
    void loadSettings()
    void loadUIPrefs()
    // ⚠️ 设置窗口**自己也要订阅**：用户可能开着两个设置窗口之外还改了东西（将来多入口时），
    //    或主窗口里切换了主题 —— 设置窗口显示的主题选中态必须跟着走。
    const off = subscribeSettingsChanged()
    return off
  }, [loadSettings, loadUIPrefs, subscribeSettingsChanged])

  /** 关窗：走主进程 —— 渲染端拿不到 BrowserWindow（架构守卫禁 import electron） */
  const close = (): void => {
    void window.api.closeSettingsWindow()
  }

  return (
    <div className="settings-window">
      <header className="settings-window-bar">
        <span className="settings-window-title">设置</span>
        <button className="settings-window-close" type="button" title="关闭设置" onClick={close}>
          <svg width="14" height="14" viewBox="0 0 16 16" aria-hidden="true">
            <path
              d="M3.5 3.5l9 9M12.5 3.5l-9 9"
              fill="none"
              stroke="currentColor"
              strokeWidth="1.5"
              strokeLinecap="round"
            />
          </svg>
        </button>
      </header>
      <SettingsView onClose={close} />
    </div>
  )
}
