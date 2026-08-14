import { createReadStream } from 'node:fs'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { tool } from '@anthropic-ai/claude-agent-sdk'
import { Client } from '@larksuiteoapi/node-sdk'
import type { CardActionEvent } from '@larksuiteoapi/node-sdk'
import { z } from 'zod'
import { respond as mcpRespond, toolName, toolServer } from './mcp.ts'
import { copyFromSandbox, execInSandbox, WORKSPACE } from './sandbox.ts'
import { secretNameError, setSecret } from './secrets.ts'

// 飞书操作是 bot 进程内的一组 MCP 工具,飞书凭证不出 bot 进程。
// 工具每轮现做,闭包里焊死 chatId/threadId,所以跨群隔离是结构性的、不靠 prompt 约束:
// 带 chat_id 的接口参数直接钉死;吃 message_id 的接口先查详情核对 chat_id 再放行
// —— message_id 是全租户通用的,少这一步就能隔着群捞数据。
// 代价是能力只有下面枚举的这些,云文档、日历等做不了。

const SERVER_NAME = 'feishu'

// 入方向只有图,且只经 prompt 内联(话题里传不了文件,所以没有落盘那条通路):
// 字节取回来转 base64 就完事,不碰沙箱文件系统。
// 出方向(send_attachment)读的是工作区,那半没挂载,得走 sandbox.ts 的 copyFromSandbox;
// 而且必须先落成宿主上的真实文件——上传飞书要经 form-data 算 Content-Length,
// 它只认能 fs.stat 出大小的文件流,拿管道没办法。

// 和 bot 本体同一份凭证(index.ts 启动时已校验);tenant token 由 SDK 自动换新,只在内存
let client: Client | null = null
const cli = () =>
  (client ??= new Client({
    appId: process.env.FEISHU_BOT_ID!,
    appSecret: process.env.FEISHU_BOT_SECRET!,
  }))

/** 飞书的报错藏在 response.data 里,原样带出模型才说得出缺哪个权限 */
const respond = (fn: () => Promise<string>) => mcpRespond(fn, errText)

export function errText(err: any): string {
  const d = err?.response?.data
  if (d && typeof d === 'object' && !d.pipe) return JSON.stringify(d)
  if (typeof d === 'string') return d
  return err?.message ?? String(err)
}

const truncate = (s: string, n = 600) => (s.length > n ? `${s.slice(0, n)}…` : s)

const fmtTime = (t?: string) =>
  t ? new Date(Number(t)).toLocaleString('zh-CN', { hour12: false }) : '?'

interface Mention { key: string; id: string; name: string }
interface MsgItem {
  message_id?: string
  thread_id?: string
  root_id?: string
  msg_type?: string
  create_time?: string
  chat_id?: string
  deleted?: boolean
  sender?: { id: string; sender_type: string; sender_name?: string }
  body?: { content: string }
  mentions?: Mention[]
}

/** 各类消息正文压成一行可读文本;附件保留 file_key,下载要用 */
function contentText(i: MsgItem): string {
  const raw = i.body?.content ?? ''
  let c: any
  try {
    c = JSON.parse(raw)
  } catch {
    return truncate(raw)
  }
  let text: string
  switch (i.msg_type) {
    case 'text':
      text = String(c.text ?? '')
      break
    case 'post': {
      const lines: string[] = c.title ? [c.title] : []
      for (const line of c.content ?? []) {
        lines.push((line as any[]).map((el) =>
          el.tag === 'text' ? el.text
          : el.tag === 'a' ? `${el.text}(${el.href})`
          : el.tag === 'at' ? `@${el.user_name ?? el.user_id}`
          : el.tag === 'img' ? `[图片 file_key=${el.image_key}]`
          : `[${el.tag}]`).join(''))
      }
      text = lines.join('\n')
      break
    }
    case 'image':
      text = `[图片 file_key=${c.image_key}]`
      break
    case 'file':
      text = `[文件 ${c.file_name ?? ''} file_key=${c.file_key}]`
      break
    case 'audio':
      text = `[语音 file_key=${c.file_key}]`
      break
    case 'media':
      text = `[视频 ${c.file_name ?? ''} file_key=${c.file_key}]`
      break
    case 'sticker':
      text = '[表情包]'
      break
    default:
      text = `[${i.msg_type}] ${truncate(raw, 200)}`
  }
  // @ 占位符换成 <at> 标签,和实时消息、发出去的消息保持同一种写法(见 bot.ts tagMentions)
  for (const m of i.mentions ?? []) text = text.replaceAll(m.key, `<at id="${m.id}">${m.name}</at>`)
  return truncate(text)
}

const senderLabel = (i: MsgItem) =>
  i.sender
    ? `${i.sender.sender_name || i.sender.id}${i.sender.sender_type === 'user' ? `(${i.sender.id})` : '[bot]'}`
    : '?'

const renderMsg = (i: MsgItem) =>
  `${i.message_id} [${fmtTime(i.create_time)}] ${senderLabel(i)}: ${i.deleted ? '[已撤回]' : contentText(i)}`

/** 查消息详情,顺带校验它属于本群 */
async function getOwnMessage(chatId: string, messageId: string): Promise<MsgItem> {
  const r = await cli().im.v1.message.get({
    params: { user_id_type: 'open_id', with_sender_name: true },
    path: { message_id: messageId },
  })
  const i = r.data?.items?.[0] as MsgItem | undefined
  if (!i) throw new Error(`消息不存在或读不到:${messageId}(${r.msg ?? `code=${r.code}`})`)
  if (i.chat_id !== chatId) throw new Error(`拒绝:消息 ${messageId} 不属于本群`)
  return i
}

const pageFooter = (hasMore?: boolean, token?: string) =>
  hasMore && token ? `\n(还有更多,翻页 page_token=${token})` : ''

async function listMessages(chatId: string, threadId?: string, pageToken?: string): Promise<string> {
  if (!threadId) {
    const r = await cli().im.v1.message.list({
      params: {
        container_id_type: 'chat', container_id: chatId, sort_type: 'ByCreateTimeDesc',
        page_size: 20, with_sender_name: true, ...(pageToken && { page_token: pageToken }),
      },
    })
    const items = (r.data?.items ?? []) as MsgItem[]
    if (!items.length) return '(没有消息)'
    return `本群最近消息(最新在前):\n${items.map(renderMsg).join('\n')}${pageFooter(r.data?.has_more, r.data?.page_token)}`
  }
  // 传进来的可能是根消息 id(om_,查详情校验归属再取出 thread_id),
  // 也可能是 thread_id 本身(omt_,查不了详情,改成核对列表返回条目的 chat_id)
  let tid = threadId
  if (!tid.startsWith('omt_')) {
    const root = await getOwnMessage(chatId, tid)
    if (!root.thread_id) return `该消息不在话题内,仅此一条:\n${renderMsg(root)}`
    tid = root.thread_id
  }
  const r = await cli().im.v1.message.list({
    params: {
      container_id_type: 'thread', container_id: tid, sort_type: 'ByCreateTimeAsc',
      page_size: 30, with_sender_name: true, ...(pageToken && { page_token: pageToken }),
    },
  })
  const items = (r.data?.items ?? []) as MsgItem[]
  if (items.some((i) => i.chat_id && i.chat_id !== chatId)) throw new Error('拒绝:该话题不属于本群')
  if (!items.length) return '(话题为空或不存在)'
  return `话题消息(最早在前):\n${items.map(renderMsg).join('\n')}${pageFooter(r.data?.has_more, r.data?.page_token)}`
}

const fmtSize = (n: number) =>
  n >= 1024 * 1024 ? `${(n / 1024 / 1024).toFixed(1)}MB` : `${Math.ceil(n / 1024)}KB`

// 内联进 prompt 的图片限制:格式限 API 认的那几种(看响应的 content-type),
// 大小给 base64 的 5MB 上限留余量;张数封顶防止富文本一堆附件撑爆上下文。
// 超限的没有备用通路:入方向只有这一条,占位符原样留在正文里、agent 看不到那张图
// (system prompt 里让它直接说看不到,别装作看见了)
const INLINE_MEDIA = ['image/jpeg', 'image/png', 'image/gif', 'image/webp'] as const
const INLINE_MAX_BYTES = 3.5 * 1024 * 1024
const INLINE_MAX_COUNT = 5

interface InlineImage {
  media: (typeof INLINE_MEDIA)[number]
  /** base64 编码的图片字节 */
  data: string
}

/**
 * 把消息里的图取回来转成 image 块,agent 回合一开始就直接看得见,不用再调工具下载。
 * messageId 来自 bot 自己收到的事件,归属可信,不再查详情核对。
 * 某一张失败就只是那一张没有,从不 reject——预处理是锦上添花,不能挡住回复。
 */
export async function prepareImages(chatId: string, messageId: string, text: string): Promise<InlineImage[]> {
  const images: InlineImage[] = []
  const imgKeys = [...new Set([...text.matchAll(/!\[image\]\((img_[\w-]+)\)/g)].map((m) => m[1]!))]
  for (const key of imgKeys.slice(0, INLINE_MAX_COUNT)) {
    try {
      const res = await cli().im.v1.messageResource.get({
        params: { type: 'image' },
        path: { message_id: messageId, file_key: key },
      })
      const media = String(res.headers?.['content-type'] ?? '').split(';')[0]!.trim()
      const chunks: Buffer[] = []
      for await (const c of res.getReadableStream()) chunks.push(c as Buffer)
      const buf = Buffer.concat(chunks)
      if (!buf.length) continue
      if ((INLINE_MEDIA as readonly string[]).includes(media) && buf.length <= INLINE_MAX_BYTES) {
        images.push({ media: media as InlineImage['media'], data: buf.toString('base64') })
      }
    } catch (err) {
      console.error(`[feishu] 图片预处理失败 chat=${chatId} key=${key}:`, errText(err))
    }
  }
  return images
}

async function listMembers(chatId: string, pageToken?: string): Promise<string> {
  const r = await cli().im.v1.chatMembers.get({
    params: { member_id_type: 'open_id', page_size: 100, ...(pageToken && { page_token: pageToken }) },
    path: { chat_id: chatId },
  })
  const items = r.data?.items ?? []
  if (!items.length) return '(拿不到成员列表)'
  return `群成员 ${r.data?.member_total ?? items.length} 人:\n` +
    items.map((m) => `${m.name}(${m.member_id})`).join('\n') +
    pageFooter(r.data?.has_more, r.data?.page_token)
}

// 飞书上传接口认的图片格式,和文件消息的专属类型;其余一律按 stream 传
const IMG_EXTS = new Set(['jpg', 'jpeg', 'png', 'webp', 'gif', 'tiff', 'bmp', 'ico'])
const FILE_TYPES: Record<string, 'opus' | 'mp4' | 'pdf' | 'doc' | 'xls' | 'ppt'> = {
  opus: 'opus', mp4: 'mp4', pdf: 'pdf', doc: 'doc', docx: 'doc',
  xls: 'xls', xlsx: 'xls', ppt: 'ppt', pptx: 'ppt',
}

/** 往话题里回一条消息;threadId 就是话题根消息 id */
async function replyToThread(threadId: string, msgType: string, content: object): Promise<void> {
  const r = await cli().im.v1.message.reply({
    path: { message_id: threadId },
    data: { msg_type: msgType, content: JSON.stringify(content), reply_in_thread: true },
  })
  if (r.code) throw new Error(`发送失败 code=${r.code}: ${r.msg}`)
}

/** 群里所有正文都用这个:飞书的纯文本消息不渲染 markdown,只能发卡片 */
const markdownCard = (content: string) => ({ elements: [{ tag: 'markdown', content }] })

/** send_message 的落点。发失败(比如超长)会被 respond 包成"失败:"回给模型自己处置 */
async function sendMessage(threadId: string, content: string): Promise<string> {
  const text = content.trim()
  if (!text) return '发送失败:content 不能为空'
  await replyToThread(threadId, 'interactive', markdownCard(text))
  return '已发进本话题'
}

/**
 * 代码自己往群里说话的唯一出口:agent 崩了没法开口时的报错卡(见 agent.ts)。抛错交调用方 catch。
 * 报错文本长度不可控,在这里统一截断,调用方不用各自记得截。
 */
export async function notifyThread(threadId: string, text: string): Promise<void> {
  await replyToThread(threadId, 'interactive', markdownCard(truncate(text)))
}

/**
 * 被 @ 的消息收到即贴「我我我」表情当回执,填沙箱冷启动到首条回复之间的静默期(index.ts 调)。
 * messageId 来自 bot 自己收到的事件,归属可信,不查详情核对(同 prepareImages)。
 * best-effort:失败只记日志、从不抛,最坏退回没有表情的现状,不能挡回复。
 */
export async function ackReceipt(messageId: string): Promise<void> {
  try {
    const r = await cli().im.v1.messageReaction.create({
      data: { reaction_type: { emoji_type: 'MeMeMe' } },
      path: { message_id: messageId },
    })
    if (r.code) console.error(`[feishu] 回执表情被拒 msg=${messageId} code=${r.code}: ${r.msg}`)
  } catch (err) {
    console.error(`[feishu] 回执表情失败 msg=${messageId}:`, errText(err))
  }
}

async function sendAttachment(chatId: string, threadId: string, p: string): Promise<string> {
  // 路径按沙箱内解:相对的接工作区,绝对的原样。不用再防越界——解析发生在沙箱里,
  // 软链指不出沙箱,能拷到的本来就都是 agent 自己读得到的东西
  const abs = p.startsWith('/') ? p : path.posix.join(WORKSPACE, p)
  // 先在沙箱里查类型和大小。不合格的当场回绝,省得白拷一趟(指到目录上会把整个目录拷出来)
  const info = (await execInSandbox(chatId, ['stat', '-L', '-c', '%F|%s', abs]).catch(() => '')).trim()
  if (!info) return `发送失败:文件不存在或不可读 ${abs}`
  const [kind = '', sizeText = ''] = info.split('|')
  const size = Number(sizeText)
  // 空文件的 %F 是 "regular empty file",所以按前缀判类型,大小另外判
  if (!kind.startsWith('regular')) return `发送失败:不是普通文件 ${abs}(${kind})`
  if (!size) return `发送失败:空文件 ${abs}`
  const name = path.posix.basename(abs)
  if (size > 30 * 1024 * 1024) return `发送失败:${name} 超过飞书文件上限 30MB(实际 ${fmtSize(size)})`

  const dir = await mkdtemp(path.join(tmpdir(), 'feishu-tag-out-'))
  try {
    const local = path.join(dir, name)
    await copyFromSandbox(chatId, abs, local)
    const ext = path.posix.extname(name).toLowerCase().slice(1)
    // 超 10MB 的图改按文件发
    if (IMG_EXTS.has(ext) && size <= 10 * 1024 * 1024) {
      const up = await cli().im.v1.image.create({
        data: { image_type: 'message', image: createReadStream(local) },
      })
      if (!up?.image_key) throw new Error('图片上传未返回 image_key')
      await replyToThread(threadId, 'image', { image_key: up.image_key })
      return `已作为图片消息发进本话题:${name}`
    }
    const up = await cli().im.v1.file.create({
      data: { file_type: FILE_TYPES[ext] ?? 'stream', file_name: name, file: createReadStream(local) },
    })
    if (!up?.file_key) throw new Error('文件上传未返回 file_key')
    await replyToThread(threadId, 'file', { file_key: up.file_key })
    return `已作为文件消息发进本话题:${name}(${fmtSize(size)})`
  } finally {
    await rm(dir, { recursive: true, force: true }).catch(() => {})
  }
}

// ── 密钥卡片 ───────────────────────────────────────────────────────────────
// 人不在宿主机前也能配密钥:agent 只给变量名,值由人填在卡片的密码框里,
// 经飞书回调直达 bot 进程写进本群凭证文件(见 secrets.ts setSecret)。
// 值全程不走消息,不进群记录也不进 agent 的 session,模型看不到。
// 不另设操作人白名单:卡片只能写它被点击的那个群,而群成员本来就共享本群的 agent 和凭证,
// 也没有跨群的凭证可写(见 secrets.ts)
const SECRET_CARD_TAG = 'feishu_tag_secret'
const SECRET_VALUE_FIELD = 'secret_value'

// 头部颜色是这张卡唯一的状态信号:待填红、存好绿、失败红
const secretCardBase = (name: string, template: 'red' | 'green') => ({
  // update_multi 让这张卡对全群是同一份状态。默认每人一份副本,会出现各看各的
  config: { update_multi: true, wide_screen_mode: true },
  header: { template, title: { tag: 'plain_text', content: `设置密钥 ${name}` } },
})

const secretCard = (name: string) => ({
  ...secretCardBase(name, 'red'),
  elements: [
    {
      tag: 'div',
      text: {
        tag: 'lark_md',
        content: '值只进 bot 进程、写入本群凭证文件,不经过 AI,也不留在消息记录里。\n' +
          '**上限 1000 字符**(飞书输入框的硬限制,超出的部分会被悄悄截掉存成错值)——更长的凭证请让管理员在宿主机上手工添加。',
      },
    },
    {
      tag: 'form',
      name: 'feishu_tag_secret_form',
      elements: [
        {
          tag: 'input',
          name: SECRET_VALUE_FIELD,
          input_type: 'password',
          placeholder: { tag: 'plain_text', content: `粘贴 ${name} 的值` },
          // 1000 是飞书的硬上限,写大了整张卡片会被 400 拒收(code 230099 / ErrCode 11310)
          max_length: 1000,
        },
        {
          tag: 'button',
          name: 'feishu_tag_secret_submit',
          action_type: 'form_submit',
          text: { tag: 'plain_text', content: '保存' },
          type: 'primary',
          value: { tag: SECRET_CARD_TAG, name },
        },
      ],
    },
  ],
})

const secretResultCard = (name: string, note: string, ok: boolean) => ({
  ...secretCardBase(name, ok ? 'green' : 'red'),
  elements: [{ tag: 'div', text: { tag: 'lark_md', content: note } }],
})

async function sendSecretCard(threadId: string, name: string): Promise<string> {
  const bad = secretNameError(name)
  if (bad) return `发送失败:${bad}`
  await replyToThread(threadId, 'interactive', secretCard(name))
  return `已把 ${name} 的输入卡片发进本话题,等对方填写提交;保存成功与否会由系统在话题里回一张结果卡,你不会拿到值。`
}

/** 打日志定位用:原始事件里带着密钥值,不能原样打印,所以只留结构、把字符串换成长度 */
const redact = (o: unknown) =>
  JSON.stringify(o, (_k, v) => (typeof v === 'string' ? `<str:${v.length}>` : v))

/**
 * 密钥卡片的提交回调(index.ts 挂在 channel 的 cardAction 上)。不是这张卡的回调一律放过。
 * form_value 不在 SDK 的归一化字段里,只能从 evt.raw 取(includeRawEvent 在 bot.ts 开着),
 * 两种嵌套都试一遍。从不抛错,抛出去会打到 SDK 的事件分发上。
 */
export async function handleSecretCardAction(evt: CardActionEvent): Promise<void> {
  // 按钮的 value 一般是对象,但飞书某些卡片形态会把它整个序列化成字符串,两种都认
  const parsed = typeof evt.action.value === 'string'
    ? ((): unknown => { try { return JSON.parse(evt.action.value as string) } catch { return null } })()
    : evt.action.value
  const v = parsed as { tag?: string; name?: string } | null
  if (!v || typeof v !== 'object' || v.tag !== SECRET_CARD_TAG) return
  const name = String(v.name ?? '')
  const raw = evt.raw as any
  const form = raw?.action?.form_value ?? raw?.event?.action?.form_value
  let note: string
  let ok = false
  try {
    if (!form || typeof form !== 'object') {
      console.error(`[feishu] 密钥卡片回调没取到 form_value,事件结构(值已脱敏):${redact(raw)}`)
      throw new Error('没收到输入框内容(已记日志)')
    }
    await setSecret(evt.chatId, name, String(form[SECRET_VALUE_FIELD] ?? ''))
    note = `✅ 已保存 **${name}**,本群下条消息起可用`
    ok = true
    console.log(`[feishu] 密钥已写入 chat=${evt.chatId} name=${name} by=${evt.operator.openId}`)
  } catch (err) {
    note = `⚠️ 保存失败:${errText(err)}`
    console.error(`[feishu] 密钥写入失败 chat=${evt.chatId} name=${name}:`, errText(err))
  }
  // 另发一条结果卡,不改原卡。原地改(message.patch)试过:表单提交后飞书会用自己的重渲染
  // 把卡片打回提交前的样子,而且它总排在我们后面,改了也会被弹回来。另发一条绕开这个状态机。
  // 回复挂在卡片消息上,reply_in_thread 保证落回同一话题(回调事件里没有 threadId)。
  // 发完撤回原卡,输入框和按钮一起消失,没人能拿旧表单再提交一次。
  // 先发后撤:撤回失败至少结果卡还在,反过来就可能什么都不剩
  try {
    await replyToThread(evt.messageId, 'interactive', secretResultCard(name, note, ok))
    console.log(`[feishu] 密钥结果已回话题 card=${evt.messageId} 状态=${ok ? '已保存' : '失败'}`)
  } catch (err) {
    console.error(`[feishu] 密钥结果发送失败 card=${evt.messageId}:`, errText(err))
  }
  try {
    const r = await cli().im.v1.message.delete({ path: { message_id: evt.messageId } })
    if (r.code) console.error(`[feishu] 原密钥卡片撤回被拒 msg=${evt.messageId} code=${r.code}: ${r.msg}`)
  } catch (err) {
    console.error(`[feishu] 原密钥卡片撤回出错 msg=${evt.messageId}:`, errText(err))
  }
}

/** agent.ts 那边引用同一份,防改名失联 */
export const SEND_MESSAGE_TOOL = toolName(SERVER_NAME, 'send_message')
export const SEND_ATTACHMENT_TOOL = toolName(SERVER_NAME, 'send_attachment')
export const SET_SECRET_TOOL = toolName(SERVER_NAME, 'set_secret')

/**
 * 每次 query 现做一个 server,闭包里捕获本轮的 chatId/threadId(见 mcp.ts)。
 * 工具名和 description 都写进了 agent.ts 的 systemPrompt 语境,改这里等于改 prompt。
 */
export function feishuServer(chatId: string, threadId: string) {
  return toolServer(SERVER_NAME, [
    tool(
      'list_messages',
      '拉取本群消息历史:不带 thread_id 列群里最近消息(最新在前),带则列该话题全部消息(最早在前)。',
      {
        thread_id: z.string().optional().describe('话题根消息 id(om_ 开头)或 thread_id(omt_ 开头);不传列群最近消息'),
        page_token: z.string().optional().describe('上次返回的翻页标记'),
      },
      ({ thread_id, page_token }) => respond(() => listMessages(chatId, thread_id, page_token)),
    ),
    tool(
      'list_members',
      '列出本群成员的名字和 open_id:认人、@ 人前查 id 用。',
      { page_token: z.string().optional().describe('上次返回的翻页标记') },
      ({ page_token }) => respond(() => listMembers(chatId, page_token)),
    ),
    tool(
      'send_message',
      '把一段 markdown 作为消息发进本话题。这是你唯一的发言通道:思考和正文输出群里没人看得见,' +
        '要说的话直接写进 content 发出,不要先在正文起草;长任务可多次调用分条发。',
      { content: z.string().describe('消息正文,markdown(飞书卡片渲染);本地路径与 ![]() 图片渲染不了,发图发文件用 send_attachment') },
      ({ content }) => respond(() => sendMessage(threadId, content)),
    ),
    tool(
      'send_attachment',
      '把本群工作区里的图片或文件作为独立消息发进本话题:jpg/png/gif/webp 等且 ≤10MB 发图片消息,其余发文件消息(≤30MB)。' +
        'send_message 的 content 里本地路径和 ![]() 渲染不了,发图发文件只能用本工具。',
      { path: z.string().describe('文件路径,相对路径按 ~/workspace 解析') },
      ({ path: p }) => respond(() => sendAttachment(chatId, threadId, p)),
    ),
    tool(
      'set_secret',
      '给本群配置一条服务密钥(第三方 API token、账号密码等):发一张带密码输入框的卡片进本话题,' +
        '由对方自己填写提交。值直连 bot 进程写入本群凭证文件,不经过你、你看不到,也不进消息记录;' +
        '保存后下条消息起该变量名就在你的命令行环境里。' +
        '任何时候都不要让对方把密钥值直接发成群消息——发出来就永久留在消息记录里了,一律改用本工具。',
      {
        name: z.string().describe(
          '环境变量名,如 SENTRY_AUTH_TOKEN(照第三方工具认的那个名字写);只能字母数字下划线,不能用 ANTHROPIC_/CLAUDE_/GIT_ 前缀',
        ),
      },
      ({ name }) => respond(() => sendSecretCard(threadId, name)),
    ),
  ])
}
