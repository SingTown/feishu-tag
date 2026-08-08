import { FeishuBot } from './bot.ts'
import { authEnv, ensureHostReady, startIdleReaper } from './sandbox.ts'
import { hasActiveSandbox, replyWithAgent, shouldHandle } from './agent.ts'
import { ackReceipt, handleSecretCardAction } from './feishu.ts'
import { startFollowupScheduler, wakeMessage } from './followup.ts'

// 飞书 SDK 在定时器里发请求、Promise 被 void 掉,业务侧挂不上 catch,不能让它带崩长连接进程。
// 副作用:漏 catch 的新代码不会再崩,只能查日志发现
process.on('unhandledRejection', (err) => console.error('[bot] 未捕获的 Promise 拒绝:', err))

const { FEISHU_BOT_ID, FEISHU_BOT_SECRET } = process.env
if (!FEISHU_BOT_ID || !FEISHU_BOT_SECRET) {
  console.error('请设置环境变量 FEISHU_BOT_ID 和 FEISHU_BOT_SECRET(可写在 .env 文件里,参考 .env.example)')
  process.exit(1)
}
// agent 跑在沙箱里,用不了宿主上 Claude 的登录态,必须显式给令牌
if (!Object.values(authEnv).some(Boolean)) {
  console.error('请设置 ANTHROPIC_API_KEY 或 CLAUDE_CODE_OAUTH_TOKEN(订阅用户可用 claude setup-token 生成;写在 .env 里,参考 .env.example)')
  process.exit(1)
}
await ensureHostReady()

const bot = new FeishuBot({ appId: FEISHU_BOT_ID, appSecret: FEISHU_BOT_SECRET })

// 密钥卡片的提交回调(见 feishu.ts)。卡片交互不是消息,门面不管,直接用 SDK 的 channel
bot.channel.on('cardAction', handleSecretCardAction)

bot.onMessage(async (msg) => {
  if (!await shouldHandle(msg)) return
  console.log(`[消息] chat=${msg.chatId} thread=${msg.threadId} text=${msg.text}`)
  // 免 @ 不贴:接不接话是模型的判断,贴了回执却可能没下文。也不能 await——按群串行,多等一拍全群堵一拍
  if (msg.mentionedBot) void ackReceipt(msg.messageId)
  // 不等回合跑完。LarkChannel 按群串行,handler 挂着的话回合进行中到的消息根本递不进去。
  // 代价是同群不同话题会真并发,可能同时动一个工作区,冲突让模型自己从报错里看出来
  void replyWithAgent(msg)
})

await bot.start()
console.log('[feishu-bot] 长连接已建立,等待群聊 @消息与话题内追问')

// 定时回访(见 followup.ts)。放 start() 之后:停机期间过期的排期会立即补火,得等长连接就绪
await startFollowupScheduler((f) => replyWithAgent(wakeMessage(f)))

// 空闲沙箱停机回收(见 sandbox.ts)。活会话表在 agent.ts,注进去避免 sandbox.ts 反向依赖它。
// 放回访之后:补火那一批刚把沙箱用起来,先让它们进活会话表,免得第一轮扫描误判空闲
startIdleReaper(hasActiveSandbox)
