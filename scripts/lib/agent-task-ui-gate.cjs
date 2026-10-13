/** 生产 React/preload 的可见任务与原生点击；主进程由无凭证 IPC 夹具替代。 */
const { join } = require('node:path')
module.exports = async ({ win, checkTrue, calls, shots }) => {
  const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
  const js = (source) => win.webContents.executeJavaScript(source)
  await js(`(() => {
    if (!document.querySelector('.dock')) document.querySelector('.panel-btn[title*="工作台"]')?.click();
  })()`)
  await pause(450)
  await js(`(() => {
    if (!document.querySelector('.wb-pick')) document.querySelector('.pane-add')?.click();
  })()`)
  await pause(400)
  const opened = await js(`(() => {
    const button = Array.from(document.querySelectorAll('.wb-pick')).find(b => b.textContent.trim() === '任务管理');
    button?.click(); return !!button;
  })()`)
  checkTrue('一次性任务面板实际打开', opened, opened)
  await pause(900)
  const rect = async (label) => js(`(() => {
    const button = Array.from(document.querySelectorAll('.tasks-panel button')).find(b => b.textContent.trim() === ${JSON.stringify(label)});
    if (!button) return null;
    const r = button.getBoundingClientRect();
    return { x: r.x + r.width / 2, y: r.y + r.height / 2,
      visible: r.width > 0 && r.height > 0 && r.top >= 0 && r.bottom <= innerHeight && r.left >= 0 && r.right <= innerWidth,
      disabled: button.disabled };
  })()`)
  const click = async (r) => {
    if (!r || !r.visible || r.disabled) throw new Error('专项任务按钮不可点击')
    win.webContents.sendInputEvent({ type: 'mouseDown', x: Math.round(r.x), y: Math.round(r.y), button: 'left', clickCount: 1 })
    win.webContents.sendInputEvent({ type: 'mouseUp', x: Math.round(r.x), y: Math.round(r.y), button: 'left', clickCount: 1 })
    await pause(750)
  }
  const stop = await rect('停止任务')
  checkTrue('停止入口可见且有效', stop?.visible && !stop.disabled, stop)
  await click(stop)
  checkTrue('原生停止点击携带准确任务身份', calls.stop.length === 1 && calls.stop[0] === 'ui-running', calls.stop)
  const cancelled = await js(`document.querySelector('.tasks-panel')?.textContent.includes('已停止')`)
  checkTrue('真实消费者显示停止终态', cancelled, cancelled)
  await js(`(() => {
    const area = document.querySelector('textarea[aria-label="一次性任务内容"]');
    Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set.call(area, '本地启动验证任务');
    area.dispatchEvent(new Event('input', { bubbles: true }));
  })()`)
  await pause(250)
  const execute = await rect('执行任务')
  checkTrue('停止后新任务执行入口有效', execute?.visible && !execute.disabled, execute)
  await click(execute)
  checkTrue('原生执行点击进入生产预加载接口', calls.run.length === 1 && calls.run[0].task === '本地启动验证任务', calls.run)
  const completed = await js(`document.querySelector('.tasks-panel')?.textContent.includes('本地夹具执行完成')`)
  checkTrue('真实消费者显示完成与输出', completed, completed)
  const image = await win.capturePage()
  require('node:fs').writeFileSync(join(shots, 'verify-agent-tasks.png'), image.toPNG())
  console.log('AGENT_TASKS_UI=' + JSON.stringify({ stop, execute, calls, cancelled, completed, realProviderRequests: 0 }))
}
