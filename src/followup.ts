import { readdir, readFile } from 'node:fs/promises'
import path from 'node:path'
import { tool } from '@anthropic-ai/claude-agent-sdk'
import { z } from 'zod'
import type { BotMessage } from './bot.ts'
import { textResult, toolName, toolServer } from './mcp.ts'
import { SANDBOX_ROOT, sandboxDir, writeAtomic } from './sandbox.ts'

// 定时回访。agent 的回合一结束进程就没了,CLI 自带的唤醒和后台任务全部失效
// (它曾用 ScheduleWakeup 向群里承诺"回来汇报"然后石沉大海)。
// 这里给它一个真承诺:排期记在 bot 进程并落盘,到点由 index.ts 合成一条消息重新唤起 agent,
// resume 原话题的 session,上下文不丢。要等更久就在回访轮里再排一次。
// 触发即删;bot 停机期间错过的,重启后立刻补火。

export interface Followup {
  chatId: string
  threadId: string
  task: string
  dueAt: number
}

/**
 * 排期是群数据,和会话记录、凭证一样落在 `sandbox/<id>/` 里,不搞仓库根的全局文件:
 * 群一清(删掉 `sandbox/<id>/`)排期跟着没,否则到点还会去唤醒那个群、
 * 把刚删掉的沙箱重新建回来;备份 `sandbox/` 也就顺带把排期备了。
 * 目录名是 chatId 的哈希、反推不回去,所以条目里的 chatId 字段是唤醒时的唯一来源,别省。
 */
const STORE_FILE = 'followups.json'
const storeOf = (chatId: string): string => path.join(sandboxDir(chatId), STORE_FILE)

const MAX_PER_THREAD = 3
const MAX_TOTAL = 100
const MAX_DELAY_MIN = 7 * 24 * 60
const TICK_MS = 30_000

// 内存里按群摊平成一张表(全局上限、到期扫描都按它算),落盘时再按群拆回去
let items: Followup[] = []

/** 启动时把各群的排期读回来。某个群的文件坏了只丢它自己的,别的群照常 */
async function load(): Promise<Followup[]> {
  const all: Followup[] = []
  for (const id of await readdir(SANDBOX_ROOT).catch(() => [])) {
    const file = path.join(SANDBOX_ROOT, id, STORE_FILE)
    // 没排过期的群根本没有这个文件,是常态;能读出来却解析不了才是真出事了,得说一声
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

// 落盘串行化。并发排期时后写覆盖前写没关系(filter 在链上执行时才做,取的是当时的 items),
// 只是不让两次 write 交错。不返回 promise,没人需要等它,失败只记日志
let saving: Promise<void> = Promise.resolve()
function save(chatId: string): void {
  saving = saving
    // 沙箱目录正常是 ensureSandbox 建好的,writeAtomic 会补一手,免得目录被清掉时排期静默丢失
    .then(() => writeAtomic(storeOf(chatId), JSON.stringify(items.filter((i) => i.chatId === chatId), null, 2) + '\n'))
    .catch((err) => console.error('[followup] 排期落盘失败:', err))
}

const fmt = (t: number) =>
  new Date(t).toLocaleString('zh-CN', { hour12: false, month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' })

/** system prompt 和唤醒词引用同一份,防改名失联 */
const SERVER_NAME = 'followup'
const TOOL_NAME = 'schedule_followup'
export const FOLLOWUP_TOOL = toolName(SERVER_NAME, TOOL_NAME)

/** 排一条回访。成败都用文本回,模型据此决定能不能向用户承诺"会回来汇报" */
function schedule(chatId: string, threadId: string, task: string, delayMinutes: number): string {
  const t = task.trim()
  if (!t) return '排期失败:task 不能为空'
  const mins = Math.min(Math.max(Math.round(delayMinutes), 1), MAX_DELAY_MIN)
  const inThread = items.filter((i) => i.threadId === threadId).length
  if (inThread >= MAX_PER_THREAD) return `排期失败:本话题已有 ${inThread} 个待回访(上限 ${MAX_PER_THREAD}),改为当轮等待或合并任务`
  if (items.length >= MAX_TOTAL) return `排期失败:全局待回访已达上限 ${MAX_TOTAL}`
  const dueAt = Date.now() + mins * 60_000
  items.push({ chatId, threadId, task: t.slice(0, 2000), dueAt })
  save(chatId)
  return `已排定:${fmt(dueAt)} 回访(${mins} 分钟后;本话题待回访 ${inThread + 1}/${MAX_PER_THREAD})`
}

/** 每次 query 现做一个 server,闭包捕获本轮的 chatId/threadId(见 mcp.ts) */
export function followupServer(chatId: string, threadId: string) {
  return toolServer(SERVER_NAME, [
    tool(
      TOOL_NAME,
      '排定一次定时回访:到点后系统会在本话题重新唤起你执行 task。用于等待 CI/构建/部署等长任务的结果;' +
        '只有本工具返回"已排定"后,才可以向用户承诺"会回来汇报"。回访时任务还没完成可以再次排期继续等。',
      {
        task: z.string().describe(
          '回访时要做什么的自包含描述:要查的命令、要验证的 URL、要汇报的内容。回访轮的你只能看到这段文字和话题上下文',
        ),
        delay_minutes: z.number().describe(`多少分钟后回访(1~${MAX_DELAY_MIN})`),
      },
      async ({ task, delay_minutes }) => textResult(schedule(chatId, threadId, task, delay_minutes)),
    ),
  ])
}

/**
 * 回访轮的合成消息,正文会当作用户消息进 transcript。
 * messageId 取 threadId:回访不该触发 agent.ts 里"话题内追问但缺 session"的回源提示。
 * mentionedBot 置 true:回访是 agent 自己排的,不做免 @ 接话判定,出错也要报进话题。
 */
export function wakeMessage(f: Followup): BotMessage {
  const lateMin = Math.round((Date.now() - f.dueAt) / 60_000)
  const late = lateMin >= 2 ? `(原定 ${fmt(f.dueAt)},因系统重启迟到约 ${lateMin} 分钟,汇报时请说明)` : ''
  return {
    chatId: f.chatId,
    threadId: f.threadId,
    messageId: f.threadId,
    mentionedBot: true,
    text: `[定时回访]${late} 你在本话题排定的检查到期了:\n${f.task}\n\n现在执行它并把结果用 send_message 发进话题;若目标任务还没完成,简短说明进度并再次用 ${FOLLOWUP_TOOL} 排期。`,
  }
}

/**
 * 先把各群落盘的排期读回来,然后每 30 秒扫一遍,到期的先删再触发,续期由回访轮自己再排。
 * 要放在 bot.start() 之后调用:补火的过期排期得等长连接就绪才发得出消息。
 * 回访逐条串行(跨 tick 共用一条链):停机很久后重启可能一次补火几十条,并发全放会挤爆宿主。
 * 串行成立的前提是 fire 返回的 promise 要等到进程退出才落定——真实消息那条路是受理即返回的
 * (见 agent.ts),同一个入口两种等法,改那边时别把这里的洪峰保护顺手拆了。
 */
export async function startFollowupScheduler(fire: (f: Followup) => Promise<void>): Promise<void> {
  items = await load()
  let firing: Promise<void> = Promise.resolve()
  const tick = () => {
    const now = Date.now()
    const due = items.filter((i) => i.dueAt <= now)
    if (!due.length) return
    items = items.filter((i) => i.dueAt > now)
    for (const chatId of new Set(due.map((i) => i.chatId))) save(chatId)
    for (const f of due) {
      firing = firing
        .then(() => {
          console.log(`[followup] 回访触发 chat=${f.chatId} thread=${f.threadId} task=${f.task.slice(0, 60)}`)
          return fire(f)
        })
        .catch((err) => console.error(`[followup] 回访执行失败 thread=${f.threadId}:`, err))
    }
  }
  tick() // 停机期间过期的立即补火
  setInterval(tick, TICK_MS).unref()
}
