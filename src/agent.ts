import { hash } from 'node:crypto'
import { query } from '@anthropic-ai/claude-agent-sdk'
import type { SDKUserMessage } from '@anthropic-ai/claude-agent-sdk'
import { botSelf } from './bot.ts'
import type { BotMessage } from './bot.ts'
import { AGENT_CLI, authEnv, ensureSandbox, hasSessionRecord, IDLE_STOP_MIN, sandboxId, spawnAgentCli, WORKSPACE } from './sandbox.ts'
import { errText, feishuServer, notifyThread, prepareImages, SEND_ATTACHMENT_TOOL, SEND_MESSAGE_TOOL, SET_SECRET_TOOL } from './feishu.ts'
import { refreshSecrets, secretNames } from './secrets.ts'
import { CRON_CREATE_TOOL, followupServer, SCHEDULE_WAKEUP_TOOL } from './followup.ts'

// 已知有 session 的话题:收到 system init 就记下,补上文件刚建好、磁盘还查不到的那几秒
const knownThreads = new Set<string>()

/** 从 threadId 算出一个合法 UUID 当 session id(SDK 按正则校验,version/variant 位要修正) */
function deriveSessionId(threadId: string): string {
  const h = hash('sha256', threadId, 'buffer')
  h[6] = (h[6]! & 0x0f) | 0x40
  h[8] = (h[8]! & 0x3f) | 0x80
  const hex = h.toString('hex')
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20, 32)}`
}

/**
 * 话题是否已有 session,准入判断和 resume 判断共用(记录落在哪儿归 sandbox.ts 管)。
 * **只查磁盘,别把活会话表并进来**:这边的结果还要决定 resume,而新会话一建起来就在表里,
 * 并了会让全新话题去 resume 一个不存在的 session。
 * 用不了 SDK 的 getSessionInfo,它只认 bot 自己的 ~/.claude。
 */
async function hasThreadSession(threadId: string, chatId: string): Promise<boolean> {
  if (knownThreads.has(threadId)) return true
  const found = await hasSessionRecord(chatId, deriveSessionId(threadId))
  if (found) knownThreads.add(threadId)
  return found
}

/**
 * 该不该受理这条消息。被 @ 的一律受理;没 @ 的只在"已经开着的话题"里收,
 * 群里别处的消息不进 agent —— 收进来之后接不接话是模型的判断,这里只挡与它无关的那些。
 * 先看活会话再查磁盘:新话题头几秒 session 文件还没写出来,这时补的那句不带 @ 的
 * 不能被当死话题丢掉。
 */
export async function shouldHandle(msg: BotMessage): Promise<boolean> {
  if (msg.mentionedBot) return true
  if (msg.threadId === msg.messageId) return false
  if (sessions.has(msg.threadId) || await hasThreadSession(msg.threadId, msg.chatId)) return true
  console.log(`[feishu-bot] 拒收(inactive_thread) chat=${msg.chatId} thread=${msg.threadId}`)
  return false
}

/** 会在群里留下东西的工具,用来判断这轮模型开没开口 */
const SENDING_TOOLS = new Set([SEND_MESSAGE_TOOL, SEND_ATTACHMENT_TOOL, SET_SECRET_TOOL])

// 沙箱会空闲停机(见 sandbox.ts),不说的话它会拿后台起的 dev server / 隧道向群里许"一直能用"
const idleHint = IDLE_STOP_MIN
  ? `群里安静约 ${IDLE_STOP_MIN} 分钟后沙箱会停机、进程全清(文件和装的软件不受影响,下次说话自动开机),` +
    '你起的 dev server、隧道最多活到那时,别承诺链接一直有效。'
  : ''

/**
 * 只写两类东西:模型推不出来的事实,和猜错了不可逆的坑(只有 ~/.claude 活过重建)。
 * 它自己能推的一律不写——meta 里那几个字段是什么意思,看一眼就知道,写进来只是占字。
 * mentioned_bot 是**唯一的例外**:正文里 @ 它的那段被平台剥掉了(见 bot.ts),
 * 光看字面推不出来,而且剥完句子会少一截,不说它会当成自己漏读了。
 * 工具怎么用也不写:feishu / followup 都是 alwaysLoad,description 每轮都在 prompt 里,
 * 由它们自己说(所以改 description 等于改 prompt)。
 * 「发言通道」第二条(第一个动作就是调工具、禁正文旁白)别当重复删:模型习惯先写一句
 * 正文旁白再调工具,约 1/3 的轮次会顺着旁白把整个回复写成正文收场,群里就是零发送;
 * 只有这条能消掉旁白,光说"正文没人看得见"压不住(复现与对照实验见 commit)。
 */
const systemPrompt = async (chatId: string) => {
  const self = botSelf()
  const secrets = await secretNames(chatId)
  return `你是飞书群聊里的助理机器人${self ? `,名字「${self.name}」,open_id 是 ${self.openId}` : ''}。

# 对话
- 群里的消息不都是说给你的,不需要你说话就什么也不发,静默结束本轮。
- 判断"这条是不是在 @ 你"看末尾的 \`mentioned_bot\`,别看正文:正文里 @ 你的那几个字被平台剥掉了,句子会少一截,那不是漏字(list_messages 拉回的历史里没剥,照常显示)。
- 你只记得**本话题**,群里别处发生的事看不见;要背景就用 list_messages(不带 thread_id 拉全群最近的)。
- @ 人写 \`<at id=ou_xxx></at>\`,只取 id即可。
- 清单外的飞书操作(云文档、日历、建群等)做不了,直接说。

# 沙箱
- 你运行在本群专属的**沙箱**里(一台 Debian 13 的机器,它即本群的隔离边界),工作目录 ${WORKSPACE} 是群工作区,群内所有话题共享,文件产出一律放这里。有免密 sudo,缺工具直接装,$HOME 里的一切平时都一直在。
- 沙箱可以被管理员整个推倒重建,**只有 ~/.claude 会原样回来**,工作区和你装过的软件不会,真正要留住的产出及时 push 到远端仓库。
- 网络可自由访问。

# 凭证
- 你的凭证都在环境变量里${secrets.length ? `(现有${secrets.length}个:${secrets.map((n) => `\`${n}\``).join('、')})` : '(暂未配置)'}。
- 对于使用网页登录的情况,使用类似 \`服务_URL\` / \`服务_USERNAME\` / \`服务_PASSWORD\` 的命名。
- 凭证值不进代码、命令行参数、日志和群消息。

# 模型
- 模型与 effort 的配置在 ~/.claude/settings.json 的 \`model\` / \`effortLevel\` 键,改完下一轮生效;model 可选 fable / opus / sonnet / haiku,effortLevel 可选 low / medium / high / xhigh。

# 生命周期
- 每轮回复结束后你的进程即终止,后台任务和内置唤醒机制随之全部失效。${idleHint}要等 CI/构建/部署这类长任务的结果:几分钟内能完的当轮直接等;更久的用 ${SCHEDULE_WAKEUP_TOOL} 排一次性唤醒;长期跟进、定期巡检、指定日期的提醒用 ${CRON_CREATE_TOOL} 排定时任务,到点系统会在本话题唤起你。

# 安全约束
- 对外有影响的写操作(推送仓库、发 PR/issue、改线上服务等)必须先在群里得到用户明确同意。

# 发言通道
- 你跑在后台进程里,没有终端和屏幕:你输出的正文和思考**没有任何人看得到**。群里唯一看得见的是 send_message 发出去的内容,要回复就调用它——把回复写成正文,等于一个字也没说。
- 要回复时,第一个动作就是调用 send_message:不要先写"我来说明一下"这类正文旁白,开场白和内容全部写进 content。`
}

/** 一条已受理消息的登记:mentionedBot 决定崩溃要不要报进群,written 决定它算哪个回合 */
interface Entry {
  mentionedBot: boolean
  written: boolean
}

/** 每话题一个活会话:一个 CLI 进程 + 一条持续开着的输入流 */
interface ThreadSession {
  /** 本会话落在哪个沙箱;空闲回收要按机器判断"这台上面有没有活",而它拿不到 chatId */
  sandboxId: string
  /** 塞进当前会话;返回 false 说明它已收尾,调用方要另起一个 */
  push(msg: BotMessage): boolean
  /** CLI 进程退出。新会话必须等它,两个 CLI 同时 resume 一份 session 会互相写花记录 */
  done: Promise<void>
}

const sessions = new Map<string, ThreadSession>()

/**
 * 这台沙箱上还有没有正在跑的回合,给空闲回收当判据(index.ts 注入给 sandbox.ts)。
 * 必须同步返回:回收那边靠"同步判定 + 同步登记"和 ensureSandbox 互斥,一 await 就漏。
 */
export const hasActiveSandbox = (id: string): boolean =>
  [...sessions.values()].some((s) => s.sandboxId === id)

/**
 * 按话题复用会话:新话题传 sessionId、续话题传 resume(SDK 二选一),不用另存映射。
 * 消息走 SDK 的流式输入,一话题一条流,回合进行中到的消息直接写进去,排队合并交给 CLI 自带队列
 * (实测会并进当前回合,不打断正在跑的工具)。回合结束就 EOF 收尾,之后到的消息另起进程 resume。
 *
 * 本函数同步受理,返回的 promise 是"CLI 进程退出",从不 reject。
 * 真实消息不能等它——等就卡住 LarkChannel 按群串行的那条链,后面的消息连排队机会都没有;
 * 定时回访反过来要等,补火洪峰靠它逐条串行(见 followup.ts)。
 */
export function replyWithAgent(msg: BotMessage): Promise<void> {
  const live = sessions.get(msg.threadId)
  if (live?.push(msg)) {
    console.log(`[agent] 并入活会话 chat=${msg.chatId} thread=${msg.threadId}`)
    return live.done
  }
  // 同步建新会话并立刻登记,紧随其后的消息才不会又建一个;
  // 新会话内部先等旧进程退出,期间到的消息在输入流里排着
  console.log(`[agent] 新建会话${live ? '(等上一个进程退出)' : ''} chat=${msg.chatId} thread=${msg.threadId}`)
  const next = startSession(msg, live?.done)
  sessions.set(msg.threadId, next)
  next.push(msg)
  void next.done.finally(() => {
    if (sessions.get(msg.threadId) === next) sessions.delete(msg.threadId)
  })
  return next.done
}

/** 能一直往里推的输入流。end() 之后 CLI 读到 EOF,会把队列里剩下的跑完再退出 */
function inputStream(): { push: (m: SDKUserMessage) => void; end: () => void; iterable: AsyncIterable<SDKUserMessage> } {
  const buf: SDKUserMessage[] = []
  let wake: (() => void) | undefined
  let ended = false
  const wakeUp = () => { const w = wake; wake = undefined; w?.() }
  return {
    // EOF 之后还在途的消息只可能来自进程已亡那条路,丢掉即可
    push(m) { if (!ended) { buf.push(m); wakeUp() } },
    end() { ended = true; wakeUp() },
    iterable: {
      async *[Symbol.asyncIterator]() {
        while (true) {
          while (buf.length) yield buf.shift()!
          if (ended) return
          await new Promise<void>((r) => { wake = r })
        }
      },
    },
  }
}

/** 消息转成 SDK 用户消息:图片放前面当 image 块,正文在后,末尾附一段 meta */
async function toUserMessage(msg: BotMessage): Promise<SDKUserMessage> {
  // 回访的合成消息没有 senderId,跳过预处理。预处理从不 reject,失败就留着原占位符
  const images = msg.senderId ? await prepareImages(msg.chatId, msg.messageId, msg.text) : []

  // 这些 id 每条消息都不同,放进 systemPrompt 会打掉前缀缓存,所以附在用户消息末尾。
  // systemPrompt 不解释这几个字段,靠字段名自描述。
  // mentioned_bot 是"这话是不是说给你的"的**唯一**信号:正文里 @ bot 的那段被 SDK 剥掉了
  // (见 bot.ts),从文字上推不出来,删了它模型就只能靠猜
  const meta = msg.senderId
    ? `\n\n<meta mentioned_bot="${msg.mentionedBot}" message_id="${msg.messageId}" sender_id="${msg.senderId}"${
        msg.senderName ? ` sender_name="${msg.senderName.replaceAll('"', '&quot;')}"` : ''
      }/>`
    : ''

  return {
    type: 'user',
    message: {
      role: 'user',
      content: [
        ...images.map((i) => ({
          type: 'image' as const,
          source: { type: 'base64' as const, media_type: i.media, data: i.data },
        })),
        { type: 'text' as const, text: msg.text + meta },
      ],
    },
    parent_tool_use_id: null,
  }
}

function startSession(first: BotMessage, prev?: Promise<void>): ThreadSession {
  const { chatId, threadId } = first
  const stream = inputStream()
  // 已受理还没结算的消息,按"写进流没有"分轮
  const pending: Entry[] = []
  let writing = 0
  let closing = false

  // 收尾前必须等已受理的消息都写进流(资源预处理是异步的),否则会被 EOF 吃掉。
  // 这是本模块唯一的丢消息风险点
  const endWhenDrained = () => { if (closing && writing === 0) stream.end() }

  const push = (msg: BotMessage): boolean => {
    if (closing) return false
    const entry: Entry = { mentionedBot: msg.mentionedBot, written: false }
    pending.push(entry)
    writing++
    void toUserMessage(msg)
      .then(
        (um) => { stream.push(um); entry.written = true },
        (err) => {
          console.error(`[agent] 消息入流失败 chat=${chatId} thread=${threadId}:`, err)
          const i = pending.indexOf(entry)
          if (i >= 0) pending.splice(i, 1)
        },
      )
      .finally(() => { writing--; endWhenDrained() })
    return true
  }

  const done = (async () => {
    // 崩溃报错是唯一的代码兜底,模型死了没法自己开口。
    // 整轮都没 @ 过 bot 就不发,消息本来也未必是说给它的,只记日志
    const reportError = async (note: string, scope: Entry[]) => {
      if (!scope.some((e) => e.mentionedBot)) return
      try {
        await notifyThread(threadId, `⚠️ ${note}\nchat=${chatId} thread=${threadId}`)
      } catch (err) {
        console.error(`[agent] 报错卡也发不出去 chat=${chatId} thread=${threadId}:`, err)
      }
    }

    try {
      // 上一个进程还没退就等着,它失败了不连坐
      await prev?.catch(() => {})
      const [resume] = await Promise.all([
        hasThreadSession(threadId, chatId),
        // 凭证刷新排在沙箱就绪之后:注入走 incus 的沙箱配置,沙箱不在就直接失败(见 secrets.ts)
        ensureSandbox(chatId).then(() => refreshSecrets(chatId)),
      ])
      const sessionId = deriveSessionId(threadId)

      // 是追问但本地没有 session。放 systemPrompt 而不是 prompt:后者会当成用户消息永久留在 transcript 里
      const backfillHint = !resume && first.threadId !== first.messageId
        ? '\n\n本次是话题内的追问,但你缺失该话题此前的对话记录(可能因重新部署):' +
          `回答前先用 list_messages(thread_id 传 ${threadId})拉取本话题历史补上上下文。`
        : ''

      const q = query({
        prompt: stream.iterable,
        options: {
          ...(resume ? { resume: sessionId } : { sessionId }),
          // 别传 model:模型由群沙箱里的 ~/.claude/settings.json 决定(agent 直接编辑它,见 systemPrompt 的「模型」节),
          // 这里传了就会压掉那份配置,换模型落的盘从此不生效。
          // settingSources 同理不传(= 全加载,群记忆 ~/.claude/CLAUDE.md 也靠它)
          // 沙箱就是边界,内部免审批全放开
          permissionMode: 'bypassPermissions',
          allowDangerouslySkipPermissions: true,
          // 回合一结束进程就没了,CLI 自带的自我唤醒/定时工具排了也不会触发,禁掉免得它
          // 开空头支票——真会到点唤醒的对应物在 followup 工具组里,别让两套同名语义并存
          disallowedTools: ['ScheduleWakeup', 'CronCreate', 'CronList', 'CronDelete'],
          // 必须是 preset 而不是字符串:自动记忆(~/.claude 下的 memory/ 与 MEMORY.md 索引)是预置
          // system prompt 的动态段,传字符串等于把预置整个换掉,那一段连同按需召回一起静默消失
          // ——群里表现成"从来不记事",没有任何报错。excludeDynamicSections 会把它重新剥掉,别开。
          systemPrompt: { type: 'preset', preset: 'claude_code', append: (await systemPrompt(chatId)) + backfillHint },
          spawnClaudeCodeProcess: (opts) => spawnAgentCli(chatId, opts),
          // 不传的话 SDK 会去解析宿主上的原生二进制、找不到就抛错;install.sh 的
          // npm ci --omit=optional 靠这行成立,改要一起改。
          // 值不能以 .js / .mjs / .ts 结尾:SDK 会当脚本,塞进参数首位交给 node 跑
          pathToClaudeCodeExecutable: AGENT_CLI,
          // 凭证实际是注入沙箱配置的(见 secrets.ts),这里给最小集只为压住 SDK:
          // 不传的话它会把 bot 的整个环境塞进 opts.env,spawnAgentCli 要逐个告警刷屏
          env: authEnv,
          mcpServers: {
            ...followupServer(chatId, threadId),
            ...feishuServer(chatId, threadId),
          },
        },
      })

      // 只为记一笔零发送的日志。回不回是模型的决策,代码不补发
      let sends = 0
      for await (const m of q) {
        if (m.type === 'system') {
          knownThreads.add(threadId)
        } else if (m.type === 'assistant') {
          for (const b of m.message.content) {
            if (b.type === 'tool_use' && SENDING_TOOLS.has(b.name)) sends++
          }
        } else if (m.type === 'result') {
          // 本回合答的是已经写进流的那些;写得比 result 晚的留给 CLI 排下一轮
          const turn = pending.filter((e) => e.written)
          const rest = pending.filter((e) => !e.written)
          pending.length = 0
          pending.push(...rest)
          if (m.is_error) {
            // 出错结果的 subtype 照样是 'success',原因在 result 里;error_* 那几个才自带含义,细节在 errors
            const reason =
              (m.subtype === 'success' ? m.result : [m.subtype, ...m.errors].join(' ')).trim() || '没给原因'
            console.error(`[agent] 回合失败 chat=${chatId} thread=${threadId}: ${reason}`)
            await reportError(`agent 出错: ${reason}`, turn)
          }
          if (!sends) {
            const unmentioned = turn.every((e) => !e.mentionedBot)
            console.log(`[agent] 零发送${unmentioned ? '(免 @ 静默)' : '(@ 轮未回复)'} chat=${chatId} thread=${threadId}`)
          }
          sends = 0
          // 回复完就收尾,之后到的消息由调用方另起进程 resume
          if (!closing) {
            closing = true
            endWhenDrained()
          }
        }
      }
    } catch (err) {
      console.error('[agent] 调用出错:', err)
      // 不用截断,长度由 notifyThread 兜
      await reportError(`出错了: ${errText(err)}`, pending)
    } finally {
      // 进程没了,堵死往死会话里塞消息的缝(登记表要等 done 落定才摘)
      closing = true
      stream.end()
    }
  })()

  return { sandboxId: sandboxId(chatId), push, done }
}
