// plan56 片②：「需你过目」从"只能看"变成"能处置"。
// K36（plan55 片①-a）把两类提示分了家，却没给出口 ⇒ 红块更准也更刺眼（K42 根因②）。
// 这一组钉的是出口的**边界**：它是提示的出口，不是记忆的删除键。
//
// ★ 本片最坏的两条歧义，判据按此设计：
//   - 只看"提示没了" ⇒ 顺手把条目删了也能绿 ⇒ 每条都同时读 `entries`（或真盘文件）；
//   - 只看"不再出现" ⇒ 等于给守卫装了永久静音键 ⇒ 必须有"改过正文后重新出现"这一条。
// 走真 fs 临时目录：`review_dismissed` 住在事件流里，内存 backend 测不到"重启后还记不记得"。

import { mkdtempSync, readFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createMemoryStore, type MemoryStore } from '@main/store/memory-store'
import { nodeFsAdapter } from '@main/store/conversations-fs'
import { serializeMemory } from '@main/memory/memory-core'
import { parseEventLine } from '@main/memory/events'
import { reviewSeenKey, reviewSeenStamp } from '@shared/memory'

const T0 = '2026-09-25T00:00:00.000Z'
const T1 = '2026-09-26T00:00:00.000Z'

/** 正文含敏感名词 ⇒ 守卫走「标记」档：条目照常生效，同时进 `needsReview`（K36 的分家语义） */
const MARK_BODY = '密钥存放在 1Password 里，需要时去那查。'
const CLEAN_BODY = '读大文件先量字节数再决定读多少，避免整份进上下文。'

let root = ''

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'mem-review-dismiss-'))
})
afterEach(() => {
  nodeFsAdapter.rmSync(root, { recursive: true, force: true })
})

function noteFile(name: string): string {
  return join(root, 'notes', `${name}.md`)
}

function writeNote(name: string, body: string, updatedAt = T0): string {
  nodeFsAdapter.mkdirSync(join(root, 'notes'), { recursive: true })
  const file = noteFile(name)
  nodeFsAdapter.writeFileSync(
    file,
    serializeMemory({
      name,
      description: `关于 ${name} 的一条经验`,
      class: 'default',
      origin: 'model',
      evidence: null,
      createdAt: T0,
      updatedAt,
      body
    })
  )
  return file
}

/** 按**指定路径**写一条（同名两条要靠不同文件名区分） */
function writeNoteAt(file: string, name: string, body: string, updatedAt = T0): string {
  nodeFsAdapter.mkdirSync(join(root, 'notes'), { recursive: true })
  nodeFsAdapter.writeFileSync(
    file,
    serializeMemory({
      name,
      description: `关于 ${name} 的一条经验`,
      class: 'default',
      origin: 'model',
      evidence: null,
      createdAt: T0,
      updatedAt,
      body
    }),
    'utf8'
  )
  return file
}

const ioText = (file: string): string => readFileSync(file, 'utf8')

function makeStore(): MemoryStore {
  return createMemoryStore(root, nodeFsAdapter, { onWarn: () => {} })
}

const reviewNames = (store: MemoryStore): string[] => store.list().needsReview.map((r) => r.name)
const kindsOf = (store: MemoryStore): string[] => store.backend.readEvents().events.map((e) => e.kind)
const countKind = (kinds: string[], kind: string): number => kinds.filter((k) => k === kind).length

describe('「看过·留下」消的是提示，不是记忆', () => {
  it('看过之后：该条不再需过目，但仍在生效列表、文件还在盘上', () => {
    const file = writeNote('vault-hint', MARK_BODY)
    const store = makeStore()
    expect(reviewNames(store)).toEqual(['vault-hint'])
    expect(store.list().entries.map((e) => e.name)).toEqual(['vault-hint'])

    expect(store.dismissReview(file)).toBe(true)

    expect(reviewNames(store)).toEqual([])
    expect(store.list().entries.map((e) => e.name)).toEqual(['vault-hint'])
    expect(existsSync(file)).toBe(true)
  })

  it('只落一条 `review_dismissed`，不落 delete / archive（消提示不许进"丢失"那笔账）', () => {
    writeNote('vault-hint', MARK_BODY)
    const store = makeStore()
    const before = store.backend.readEvents().events.length

    expect(store.dismissReview(noteFile('vault-hint'))).toBe(true)

    const kinds = kindsOf(store)
    expect(kinds.length).toBe(before + 1)
    expect(countKind(kinds, 'delete')).toBe(0)
    expect(countKind(kinds, 'archive')).toBe(0)
    const dismissed = store.backend.readEvents().events.find((e) => e.kind === 'review_dismissed')
    expect(dismissed).toMatchObject({ name: 'vault-hint' })
    // ⚠️ 事件里只有 name + 不透明指纹：**路径不许进事件流**（含用户名），指纹也不许是可反读的原文
    const json = JSON.stringify(dismissed)
    expect(json).not.toContain(root)
    expect(json).not.toMatch(/notes|tmp|[A-Za-z]:/)
    expect(json).not.toContain(MARK_BODY)
  })

  it('该条本就不在红块 ⇒ 返回 false 且不落事件（写一笔脏账 = 假成功）', () => {
    writeNote('quiet', CLEAN_BODY)
    const store = makeStore()
    expect(store.list().needsReview).toHaveLength(0)
    const before = store.backend.readEvents().events.length

    expect(store.dismissReview(noteFile('quiet'))).toBe(false)
    expect(store.dismissReview('/no/such/file.md')).toBe(false)
    expect(store.backend.readEvents().events.length).toBe(before)
  })

  // 入口身份必须是 file：按 name 找的话，同名两条提示会消掉用户**没点**的那一条
  it('两条同名提示（手复制文件就会这样）⇒ 只消掉被点的那一条', () => {
    const a = join(root, 'notes', 'a-copy.md')
    const b = join(root, 'notes', 'b-copy.md')
    writeNoteAt(a, 'same-name', MARK_BODY)
    writeNoteAt(b, 'same-name', MARK_BODY)
    const store = makeStore()
    expect(store.list().needsReview).toHaveLength(2)

    expect(store.dismissReview(a)).toBe(true)

    const left = store.list().needsReview
    expect(left).toHaveLength(1)
    expect(left[0]!.file).toBe(b)
  })
})

describe('「已看过」住在事件流里，所以重启仍记得', () => {
  it('重建 store（同一数据根）后，看过的那条依旧不在红块、也依旧在生效列表', () => {
    writeNote('vault-hint', MARK_BODY)
    writeNote('confirm-hint', '用户要求长任务期间免打扰，跑完再汇报。')
    // 上面两行写的文件路径不同、内容不同，所以下面 dismiss 只影响第一条
    expect(makeStore().dismissReview(noteFile('vault-hint'))).toBe(true)

    const second = makeStore()
    expect(reviewNames(second)).toEqual(['confirm-hint'])
    expect(second.list().entries.map((e) => e.name).sort()).toEqual(['confirm-hint', 'vault-hint'])
  })
})

describe('⚠️ 不是永久豁免：内容一改，提示重新出现', () => {
  // ★ 独立复查抓到的真缺陷（P1）：这一格存在的理由恰恰是"文件没经过确认桥"，
  //   而手改 / Agent 改文件**都不刷新 frontmatter 的 `updatedAt`** ⇒ 记账料必须是内容指纹。
  it('手改正文、`updatedAt` 一个字没动 ⇒ 提示必须重新出现（只认 updatedAt 就会静音守卫）', () => {
    const file = writeNote('vault-hint', MARK_BODY)
    const store = makeStore()
    expect(store.dismissReview(file)).toBe(true)
    expect(reviewNames(store)).toEqual([])

    // 外部改文件：只动正文，updatedAt 保持原值
    nodeFsAdapter.writeFileSync(
      file,
      ioText(file).replace('1Password', 'Keepass'),
      'utf8'
    )
    expect(ioText(file)).toContain('updatedAt: ' + T0)
    expect(reviewNames(makeStore())).toEqual(['vault-hint'])
  })

  it('只换 `updatedAt` 而正文没动 ⇒ 仍算"同一份内容"，不必再打扰用户', () => {
    const file = writeNote('vault-hint', MARK_BODY)
    expect(makeStore().dismissReview(file)).toBe(true)

    writeNote('vault-hint', MARK_BODY, T1)
    expect(reviewNames(makeStore())).toEqual([])
  })

  it('反向：正文改成不再命中守卫 ⇒ 也从红块消失，但与"看过"无关（红块真相源是守卫）', () => {
    writeNote('vault-hint', MARK_BODY)
    expect(makeStore().dismissReview(noteFile('vault-hint'))).toBe(true)
    writeNote('vault-hint', CLEAN_BODY, T1)

    const after = makeStore()
    expect(reviewNames(after)).toEqual([])
    expect(after.list().warnings).toHaveLength(0)
  })

  it('指纹本身：改一个字就换值、长度相同也不撞车；name 里的分隔符不许伪造出同一个键', () => {
    const base = {
      file: '/m/n.md',
      name: 'n',
      description: 'd',
      body: '正文一',
      evidenceConversationId: ''
    }
    expect(reviewSeenStamp(base)).toBe(reviewSeenStamp({ ...base }))
    expect(reviewSeenStamp(base)).not.toBe(reviewSeenStamp({ ...base, body: '正文二' }))
    // 等长改动是 FNV-1a 最容易撞的那一类，长度进指纹就是为了它
    expect(reviewSeenStamp({ ...base, body: '正文一' })).not.toBe(reviewSeenStamp({ ...base, body: '正文乙' }))
    expect(reviewSeenStamp({ ...base, description: '密钥在 1Password' })).not.toBe(
      reviewSeenStamp({ ...base, description: '密钥在 Keepass' })
    )
    // 同名同内容的两份手复制件必须是两个键（否则消一条 = 静音两条）
    expect(reviewSeenStamp({ ...base, file: '/a/copy-1.md' })).not.toBe(
      reviewSeenStamp({ ...base, file: '/b/copy-2.md' })
    )
    // 指纹本身不外泄原文：定长十六进制 + 长度
    expect(reviewSeenStamp(base)).toMatch(/^[0-9a-f]{8}-\d+/)
    expect(reviewSeenKey('a\u0000' + 'b', '1')).not.toBe(reviewSeenKey('a', '\u0000b' + '1'))
  })
})

describe('「全部看过」= 逐条记一笔，账目与存活率都不动', () => {
  it('两条命中 ⇒ 返回 2、红块清空、条目一条没少、存活率等读数全等', () => {
    writeNote('vault-hint', MARK_BODY)
    writeNote('confirm-hint', '用户要求长任务期间免打扰，跑完再汇报。')
    writeNote('clean', CLEAN_BODY)
    const store = makeStore()
    const statsBefore = store.computeStats(store.backend.readEvents().events)
    expect(reviewNames(store)).toEqual(['confirm-hint', 'vault-hint'])

    expect(store.dismissAllReview()).toBe(2)

    expect(reviewNames(store)).toEqual([])
    expect(store.list().entries).toHaveLength(3)
    const kinds = kindsOf(store)
    expect(countKind(kinds, 'review_dismissed')).toBe(2)
    expect(countKind(kinds, 'delete')).toBe(0)
    expect(store.computeStats(store.backend.readEvents().events)).toEqual(statsBefore)
  })

  it('红块本来就空 ⇒ 返回 0，且一条事件都不写（空操作要真空）', () => {
    writeNote('clean', CLEAN_BODY)
    const store = makeStore()
    const before = store.backend.readEvents().events.length

    expect(store.dismissAllReview()).toBe(0)
    expect(store.backend.readEvents().events.length).toBe(before)
  })

  it('批量只吃屏幕上**还剩**的那几条（已看过过的不许再记一笔）', () => {
    writeNote('a-hint', MARK_BODY)
    writeNote('b-hint', '用户要求长任务期间免打扰，跑完再汇报。')
    const store = makeStore()
    expect(store.dismissReview(noteFile('a-hint'))).toBe(true)

    // 未按"已看过"筛的话这里返回 2 ⇒ 界面写着「1 条」、实际记 2 笔，且事件流被同一笔刷屏
    expect(store.dismissAllReview()).toBe(1)
    expect(countKind(kindsOf(store), 'review_dismissed')).toBe(2)
  })

  it('盘上正文逐字节未动（这个动作只许写事件流）', () => {
    const file = writeNote('vault-hint', MARK_BODY)
    const bytesBefore = readFileSync(file)
    const store = makeStore()
    expect(store.dismissReview(file)).toBe(true)
    expect(store.dismissAllReview()).toBe(0)
    expect(readFileSync(file).equals(bytesBefore)).toBe(true)
  })
})

describe('接线：新 kind 读得回来，装配层真的筛了', () => {
  it('`review_dismissed` 能过 `parseEventLine`（不在 KINDS 白名单里 = 写了读不出，静默丢）', () => {
    writeNote('vault-hint', MARK_BODY)
    makeStore().dismissReview(noteFile('vault-hint'))
    const lines = readFileSync(join(root, 'memory', 'events.jsonl'), 'utf8')
      .split('\n')
      .filter((l) => l.trim() !== '')

    expect(lines.some((l) => l.includes('"review_dismissed"'))).toBe(true)
    expect(lines.map((l) => parseEventLine(l)).filter((e) => e === null)).toHaveLength(0)
  })
})
