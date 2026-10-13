/** 本地协作条件已失效：停止本轮，不把暂停当成普通工具失败交模型自动重试。 */
export class AgentPauseError extends Error {
  constructor(message: string) { super(message); this.name = 'AgentPauseError' }
}
