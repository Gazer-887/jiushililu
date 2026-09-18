import { useEffect } from 'react'
import SettingsView from './SettingsView'
import { useAppStore } from '../store'

/*
 * 设置**独立窗口**的外壳（2026-09-13 用户定案）。
 *
 * 顶部一行「设置」标题是**内容区内的视觉锚点**（设置窗口没有菜单栏、没有地址栏，
 * 需要一句话说清"这是什么"），下面才是「左栏分区 + 右内容」。
 *
 * ⚠️ **这里刻意不画关闭按钮**（2026-09-14 用户反馈「右上角有两个X号退出键」）：
 *    主进程建窗口用的是系统默认边框（`frame: true`），系统标题栏已带 ×；
 *    再画一个 × 垂直紧贴在它正下方，两个 × 干同一件事（关窗）——
 *    用户想关设置时极易误点到系统的那个，把整个应用关掉。出口收敛为：
 *    ① 系统标题栏 ×（唯一鼠标出口）；② Esc（键盘出口，见下）。
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

  // Esc 关窗（键盘出口）：监听在 window 上，输入框不消费 Escape，无误伤
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') void window.api.closeSettingsWindow()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])

  return (
    <div className="settings-window">
      <header className="settings-window-bar">
        <span className="settings-window-title">设置</span>
        {/* 09-18 用户：设置页定位澄清为"软件内页"——「设置」旁给一个浅色「返回」，
            与 Esc/× 同一路出口（关本窗回主窗口），不新增概念 */}
        <button className="settings-window-back" onClick={close}>
          返回
        </button>
      </header>
      <SettingsView onClose={close} />
    </div>
  )
}
