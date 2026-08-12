import { randomUUID } from 'node:crypto'
import { readdir, readFile } from 'node:fs/promises'
import path from 'node:path'
import { tool } from '@anthropic-ai/claude-agent-sdk'
import { Cron } from 'croner'
import { z } from 'zod'
import type { BotMessage } from './bot.ts'
import { textResult, toolName, toolServer } from './mcp.ts'
import { SANDBOX_ROOT, sandboxDir, writeAtomic } from './sandbox.ts'

// 定时唤醒。agent 的回合一结束进程就没了,CLI 自带的 ScheduleWakeup/Cron 排了也不会触发
// (agent.ts 已禁),这里是真会到点的对应物:排期落盘,到点合成消息重新唤起 agent,
// resume 原话题的 session;工具名和参数都照内置同名工具。
// bot 停机期间错过的,重启后只补火一次:周期任务不重放错过的窗口,下一响从当下起算。

interface Followup {
  id: string
  chatId: string
  threadId: string
  prompt: string
  /** 下一次触发时刻;周期条目每次触发后重算 */
  dueAt: number
  /** 没有此字段的是 schedule_wakeup 排的延时唤醒 */
  cron?: string
  recurring?: boolean
  /** 仅周期条目;下一响会越过它时本响改为最后一响 */
  expiresAt?: number
}

/** expr 在 t 之后的下一个触发时刻,一年内没有返回 null;表达式无效抛错,信息原样给模型看 */
function nextMatch(expr: string, t: number): number | null {
  const next = new Cron(expr).nextRun(new Date(t))
  return next === null || next.getTime() - t > 366 * 24 * 3600_000 ? null : next.getTime()
}

/**
 * 排期是群数据,和会话记录、凭证一样落在 `sandbox/<id>/` 里,群一清排期跟着没。
 * 目录名是 chatId 的哈希、反推不回去,条目里的 chatId 字段是唤醒时的唯一来源,别省。
 */
const STORE_FILE = 'followups.json'
const storeOf = (chatId: string): string => path.join(sandboxDir(chatId), STORE_FILE)

const MAX_PER_THREAD = 5
const MAX_TOTAL = 100
const MIN_DELAY_S = 60
const MAX_DELAY_S = 7 * 24 * 3600
// 周期下限和 7 天期满都是成本护栏:每一响都是起沙箱 + 完整 agent 回合;续期由最后一响提醒模型
const MIN_PERIOD_MIN = 30
const EXPIRE_DAYS = 7
const EXPIRE_MS = EXPIRE_DAYS * 24 * 60 * 60_000
const TICK_MS = 30_000

// 内存里按群摊平成一张表,落盘时再按群拆回去
let items: Followup[] = []

/** 启动时把各群的排期读回来。某个群的文件坏了只丢它自己的,别的群照常 */
async function load(): Promise<Followup[]> {
  const all: Followup[] = []
  for (const id of await readdir(SANDBOX_ROOT).catch(() => [])) {
    const file = path.join(SANDBOX_ROOT, id, STORE_FILE)
    // 没有文件是常态;有文件却解析不了才是真出事,得说一声
    const text = await readFile(file, 'utf8').catch(() => null)
    if (text === null) continue
    try {
      const arr: unknown = JSON.parse(text)
      if (Array.isArray(arr)) all.push(...(arr as Followup[]))
    } catch (err) {
      console.error(`[followup] 排期文件读不回来,本群排期已丢 ${file}:`, err)
    }
  }
  return all
}

// 落盘串行化,只为不让两次 write 交错;后写覆盖前写没关系,filter 在链上执行时才取当时的 items
let saving: Promise<void> = Promise.resolve()
function save(chatId: string): void {
  saving = saving
    // writeAtomic 会补建目录,免得目录被清掉时排期静默丢失
    .then(() => writeAtomic(storeOf(chatId), JSON.stringify(items.filter((i) => i.chatId === chatId), null, 2) + '\n'))
    .catch((err) => console.error('[followup] 排期落盘失败:', err))
}

const fmt = (t: number) => {
  const d = new Date(t)
  return d.toLocaleString('zh-CN', {
    hour12: false,
    ...(d.getFullYear() !== new Date().getFullYear() && { year: 'numeric' }),
    month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit',
  })
}

const fmtDur = (s: number) =>
  s < 7200 ? `${Math.round(s / 60)} 分钟` : s < 48 * 3600 ? `${Math.round(s / 3600)} 小时` : `${Math.round(s / 86400)} 天`

const newId = () => randomUUID().slice(0, 8)

const isRecurring = (i: Followup): boolean => Boolean(i.cron && i.recurring)

const trim120 = (s: string) => (s.length > 120 ? `${s.slice(0, 120)}…` : s)

function capacity(threadId: string): string | null {
  const n = items.filter((i) => i.threadId === threadId).length
  if (n >= MAX_PER_THREAD) return `本话题已有 ${n} 条排期(上限 ${MAX_PER_THREAD}),先用 cron_delete 清掉不需要的`
  if (items.length >= MAX_TOTAL) return `全局排期已达上限 ${MAX_TOTAL}`
  return null
}

/** system prompt 和唤醒词引用同一份,防改名失联 */
const SERVER_NAME = 'followup'
export const SCHEDULE_WAKEUP_TOOL = toolName(SERVER_NAME, 'schedule_wakeup')
export const CRON_CREATE_TOOL = toolName(SERVER_NAME, 'cron_create')
export const CRON_LIST_TOOL = toolName(SERVER_NAME, 'cron_list')
export const CRON_DELETE_TOOL = toolName(SERVER_NAME, 'cron_delete')

/** 返回文本开头的"已排定"被工具 description 当承诺开关引用,改文案要一起改 */
function schedule(chatId: string, threadId: string, prompt: string, delaySeconds: number): string {
  const t = prompt.trim()
  if (!t) return '排期失败:prompt 不能为空'
  const capped = capacity(threadId)
  if (capped) return `排期失败:${capped}`
  const secs = Math.min(Math.max(Math.round(delaySeconds), MIN_DELAY_S), MAX_DELAY_S)
  const dueAt = Date.now() + secs * 1000
  const id = newId()
  items.push({ id, chatId, threadId, prompt: t.slice(0, 2000), dueAt })
  save(chatId)
  return `已排定(id ${id}):${fmt(dueAt)} 唤醒(${fmtDur(secs)}后)`
}

/** 拒绝理由都要写明出路,模型拿到文本要能自己改对 */
function cronCreate(chatId: string, threadId: string, expr: string, prompt: string, recurring: boolean): string {
  const t = prompt.trim()
  if (!t) return '创建失败:prompt 不能为空'
  const now = Date.now()
  let first: number | null
  try {
    first = nextMatch(expr, now)
  } catch (err) {
    return `创建失败:${err instanceof Error ? err.message : String(err)}`
  }
  if (first === null) return '创建失败:这个表达式一年内一次都不会触发,检查日和月的组合'
  const capped = capacity(threadId)
  if (capped) return `创建失败:${capped}`
  const entry = { id: newId(), chatId, threadId, prompt: t.slice(0, 2000), dueAt: first, cron: expr.trim() }
  if (!recurring) {
    items.push({ ...entry, recurring: false })
    save(chatId)
    return `已创建一次性任务 ${entry.id}:${fmt(first)} 触发,触发后自动删除`
  }
  const expiresAt = now + EXPIRE_MS
  if (first > expiresAt) {
    return `创建失败:按这个表达式 ${EXPIRE_DAYS} 天内一次都不会触发,而周期任务 ${EXPIRE_DAYS} 天期满自删;` +
      '这种稀疏节奏改用 recurring 传 false 的一次性任务,到点那轮再排下一次'
  }
  const second = nextMatch(expr, first)
  if (second !== null && second - first < MIN_PERIOD_MIN * 60_000) {
    return `创建失败:周期最短 ${MIN_PERIOD_MIN} 分钟,这个表达式头两次触发只隔 ${Math.round((second - first) / 60_000)} 分钟`
  }
  items.push({ ...entry, recurring: true, expiresAt })
  save(chatId)
  return `已创建周期任务 ${entry.id}:下一次 ${fmt(first)},${fmt(expiresAt)} 期满自动删除,最后一次触发时会提醒续排`
}

function listItems(threadId: string): string {
  const mine = items.filter((i) => i.threadId === threadId).sort((a, b) => a.dueAt - b.dueAt)
  if (!mine.length) return '本话题没有排定中的定时任务'
  const lines = mine.map((i) => {
    const kind = !i.cron ? '延时唤醒' : isRecurring(i) ? `周期 ${i.cron},${fmt(i.expiresAt!)} 期满` : `一次性 ${i.cron}`
    return `${i.id} [${kind}] 下次 ${fmt(i.dueAt)}:${trim120(i.prompt)}`
  })
  return `本话题排定中的定时任务 ${mine.length} 条:\n${lines.join('\n')}`
}

function deleteItem(threadId: string, id: string): string {
  const idx = items.findIndex((i) => i.id === id && i.threadId === threadId)
  if (idx < 0) return `取消失败:本话题没有 id 为 ${id} 的定时任务(用 cron_list 查看现有的)`
  const gone = items[idx]!
  items.splice(idx, 1)
  save(gone.chatId)
  return `已取消 ${id}`
}

/** 每次 query 现做一个 server,闭包捕获本轮的 chatId/threadId(见 mcp.ts);list/delete 也只够得着本话题的条目 */
export function followupServer(chatId: string, threadId: string) {
  return toolServer(SERVER_NAME, [
    tool(
      'schedule_wakeup',
      '排定一次延时唤醒:到点后系统会在本话题重新唤起你执行 prompt(即你熟悉的 ScheduleWakeup,这里由系统' +
        '真正到点唤起;没有 noop/stop,每次唤醒都是全新回合,不续排就自然结束)。' +
        '只有本工具返回"已排定"后,才可以向用户承诺"会回来汇报/会到点处理"。' +
        '长期、周期性的跟进改用 cron_create,别拿本工具链式续排。',
      {
        delaySeconds: z.number().describe(`多少秒后唤醒(${MIN_DELAY_S}~${MAX_DELAY_S},即最长 7 天;触发精度约半分钟)`),
        prompt: z.string().describe('唤醒时要做什么的自包含描述;唤醒轮的你只能看到这段文字和话题上下文'),
      },
      async ({ delaySeconds, prompt }) => textResult(schedule(chatId, threadId, prompt, delaySeconds)),
    ),
    tool(
      'cron_create',
      '排定一个定时任务:到点后系统会在本话题重新唤起你执行 prompt。周期任务用于长期跟进、定期巡检,' +
        `最短间隔 ${MIN_PERIOD_MIN} 分钟、${EXPIRE_DAYS} 天期满自动删除(最后一次触发时会提醒你续排);` +
        '比这更稀疏的节奏(如每月一次)和"某天某时执行"用一次性任务(recurring 传 false),到点那轮再排下一次。',
      {
        cron: z.string().describe(
          '标准 5 字段 cron 表达式(分 时 日 月 周),服务器本地时区:如 "0 9 * * 1-5" 工作日九点、"30 14 15 3 *" 3月15日14:30',
        ),
        prompt: z.string().describe('触发时要做什么的自包含描述;触发轮的你只能看到这段文字和话题上下文'),
        recurring: z.boolean().optional().describe('true(默认)= 按周期重复触发;false = 触发一次后自动删除'),
      },
      async ({ cron, prompt, recurring }) => textResult(cronCreate(chatId, threadId, cron, prompt, recurring ?? true)),
    ),
    tool(
      'cron_list',
      '列出本话题排定中的全部定时任务(含 schedule_wakeup 排的),带 id、下次触发时间和任务内容。',
      {},
      async () => textResult(listItems(threadId)),
    ),
    tool(
      'cron_delete',
      '按 id 取消本话题的一个定时任务;id 在创建时的返回里,忘了就先 cron_list。',
      { id: z.string().describe('cron_create 或 schedule_wakeup 返回的任务 id') },
      async ({ id }) => textResult(deleteItem(threadId, id)),
    ),
  ])
}

/**
 * messageId 取 threadId:免碰 agent.ts 的"追问缺 session"回源提示。
 * mentionedBot 置 true:任务是 agent 自己排的,出错也要报进话题。
 * 延时唤醒要求汇报(对用户的承诺),cron 任务允许静默——两段文案的差异是刻意的。
 */
function wakeMessage(f: Followup, final: boolean, next?: number): BotMessage {
  const lateMin = Math.round((Date.now() - f.dueAt) / 60_000)
  const late = lateMin >= 2 ? `(原定 ${fmt(f.dueAt)},因系统停机迟到约 ${lateMin} 分钟,汇报时请说明)` : ''
  const text = !f.cron
    ? `[定时唤醒 ${f.id}]${late} 你在本话题排定的延时唤醒到点了:\n${f.prompt}\n\n` +
      `现在执行它并把结果用 send_message 发进话题;后续还要再来一轮就再次用 ${SCHEDULE_WAKEUP_TOOL} 排期。`
    : `[定时任务 ${f.id}]${late} 你在本话题排定的定时任务(cron ${f.cron})触发了:\n${f.prompt}\n\n` +
      '现在执行它;有值得说的用 send_message 发进话题,没有就静默结束。' +
      (final
        ? `\n本任务已满 ${EXPIRE_DAYS} 天期限,这是最后一次触发、已自动删除:还需要继续就重新用 ${CRON_CREATE_TOOL} 排。`
        : f.recurring
          ? `\n下一次触发 ${fmt(next!)};不再需要就用 ${CRON_DELETE_TOOL} 取消(id ${f.id})。`
          : '\n一次性任务,已自动删除;要继续跟进就重新排期。')
  return { chatId: f.chatId, threadId: f.threadId, messageId: f.threadId, mentionedBot: true, text }
}

/** 周期条目的下一响;期满或表达式坏了(落盘被手改过)返回 null,本响即成最后一响 */
function nextFireAt(i: Followup, now: number): number | null {
  let next: number | null
  try {
    next = nextMatch(i.cron!, now)
  } catch {
    return null
  }
  return next === null || (i.expiresAt !== undefined && next > i.expiresAt) ? null : next
}

/**
 * 要放在 bot.start() 之后调用:补火的过期排期得等长连接就绪才发得出消息。
 * 触发逐条串行(跨 tick 共用一条链),防停机后一次补火几十条挤爆宿主;串行成立的前提是
 * fire 返回的 promise 等到进程退出才落定——真实消息那条路是受理即返回的(见 agent.ts),
 * 同一个入口两种等法,改那边时别顺手拆了这里的洪峰保护。
 */
export async function startFollowupScheduler(fire: (msg: BotMessage) => Promise<void>): Promise<void> {
  items = await load()
  let firing: Promise<void> = Promise.resolve()
  const tick = () => {
    const now = Date.now()
    if (!items.some((i) => i.dueAt <= now)) return
    const fired: Array<{ f: Followup; final: boolean; next?: number }> = []
    const keep: Followup[] = []
    for (const i of items) {
      if (i.dueAt > now) {
        keep.push(i)
        continue
      }
      if (!isRecurring(i)) {
        fired.push({ f: i, final: false })
        continue
      }
      const next = nextFireAt(i, now)
      if (next === null) fired.push({ f: i, final: true })
      else {
        fired.push({ f: i, final: false, next })
        keep.push({ ...i, dueAt: next })
      }
    }
    items = keep
    for (const chatId of new Set(fired.map(({ f }) => f.chatId))) save(chatId)
    for (const { f, final, next } of fired) {
      // 唤醒消息在串行链上现做,迟到标注才对得上真实发出时刻
      firing = firing
        .then(() => {
          console.log(`[followup] 触发 chat=${f.chatId} thread=${f.threadId} id=${f.id} prompt=${f.prompt.slice(0, 60)}`)
          return fire(wakeMessage(f, final, next))
        })
        .catch((err) => console.error(`[followup] 触发执行失败 thread=${f.threadId}:`, err))
    }
  }
  tick() // 停机期间过期的立即补火
  setInterval(tick, TICK_MS).unref()
}
