import { createLarkChannel } from '@larksuiteoapi/node-sdk'
import type { LarkChannel } from '@larksuiteoapi/node-sdk'

export interface BotMessage {
  chatId: string
  /** 话题的稳定 key:话题内取根消息 id,新 @消息取自身 id */
  threadId: string
  /** 触发消息自身 id;不等于 threadId 就是话题内追问 */
  messageId: string
  /** 发送者 open_id;定时回访的合成消息没有 */
  senderId?: string
  senderName?: string
  mentionedBot: boolean
  text: string
}

/**
 * 正文里的 @ 经 SDK 归一化后只剩人名,这里换回 <at> 标签,让 agent 抄一下就能 @ 回去。
 * 按名字从长到短替换,免得短名是长名的前缀时切错;@all 这种没 name/openId 的原样留着。
 */
function tagMentions(content: string, mentions: { openId?: string; name?: string }[]): string {
  let out = content
  for (const m of [...mentions].sort((a, b) => (b.name?.length ?? 0) - (a.name?.length ?? 0))) {
    if (m.name && m.openId) out = out.replaceAll(`@${m.name}`, `<at id="${m.openId}">${m.name}</at>`)
  }
  return out
}

/** bot 自己的 open_id 和名字,connect() 后由 SDK 填好;进 systemPrompt 让 agent 认得出谁在 @ 它 */
let self: { openId: string; name: string } | undefined
export const botSelf = (): { openId: string; name: string } | undefined => self

export type MessageHandler = (msg: BotMessage) => void | Promise<void>

/**
 * LarkChannel 之上的薄门面,只管收消息(过滤自己发的 + 字段映射),回不回由接线方决定。
 * 发消息不走这里:群里可见的一切都由模型调 feishu 工具发出(见 feishu.ts)。
 * 收全量群消息要 im:message.group_msg 权限。去重、排队、重试都是 LarkChannel 内置的,
 * 门面没覆盖到的能力直接用 bot.channel。
 */
export class FeishuBot {
  readonly channel: LarkChannel

  constructor({ appId, appSecret }: { appId: string; appSecret: string }) {
    if (!appId || !appSecret) throw new Error('FeishuBot 需要 appId 和 appSecret')
    this.channel = createLarkChannel({
      appId,
      appSecret,
      policy: { dmMode: 'disabled', requireMention: false },
      // 密钥卡片的 form_value 不在 SDK 的归一化字段里,只能从 evt.raw 取(见 feishu.ts)。
      // 这一个开关同时喂消息和卡片回调两条归一化,关掉的话卡片点"保存"就取不到输入框内容
      includeRawEvent: true,
    })
    this.channel.on('error', (err) => console.error('[feishu-bot]', err.message))
    this.channel.on('reject', (evt) => console.log(`[feishu-bot] 拒收(${evt.reason}) chat=${evt.chatId}`))
  }

  onMessage(fn: MessageHandler): this {
    this.channel.on('message', async (m) => {
      if (m.senderId === this.channel.botIdentity?.openId) return
      const msg: BotMessage = {
        chatId: m.chatId,
        threadId: m.rootId ?? m.threadId ?? m.messageId,
        messageId: m.messageId,
        senderId: m.senderId,
        senderName: m.senderName,
        mentionedBot: m.mentionedBot,
        // 正文里 @ bot 自己的那段已经被 SDK 剥掉了(LarkChannel 写死 stripBotMentions: true),
        // 补不回来也不补:被没被 @ 由 mentionedBot 单独带走,进 agent 时落成 meta 字段(见 agent.ts)
        text: tagMentions(m.content, m.mentions),
      }
      try {
        await fn(msg)
      } catch (err) {
        console.error('[feishu-bot] onMessage 处理出错:', err)
      }
    })
    return this
  }

  async start(): Promise<void> {
    await this.channel.connect()
    self = this.channel.botIdentity
  }
}
