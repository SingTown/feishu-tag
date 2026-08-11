import { registerApp } from '@larksuiteoapi/node-sdk'
import type { AppAddons } from '@larksuiteoapi/node-sdk'
import QRCode from 'qrcode'
import { readFile, rename, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

// .env 相对仓库根解析,先切过去,`node src/register.ts` 从哪儿调都一样
process.chdir(path.resolve(fileURLToPath(import.meta.url), '../..'))

/**
 * 建飞书应用的命令入口(`npm run register`)。确认页上既能新建,也能**选择已有应用**——
 * 后者就是「给现网应用增量开通权限」的运维路径:改了下面的清单后重跑本命令,
 * 确认页选中原来那个应用即可,app_id 和 secret 都不会变。
 * install.sh 装完后由用户自己跑(安装器全程零交互,不代跑);不在运行时链路上;
 * 要用户拿手机飞书确认。凭证直接写 .env、不打印——飞书凭证全程不出这个进程
 * (模型令牌那半由用户直接写 .env,同样不进这里)。
 */

// 权限策略(2026-08-08 拍板):走**平台默认模板**(preset:true)——路线图会用到里面的
// 大部分能力(云文档、Pin、卡片、妙记、建群…),一次拿齐,省得每加一个功能都要
// 再扫码开通一遍;确认 URL 也因此短了一半多(权限不再逐条挂在上面)。代价是知情的:
// 模板权限只能加不能减,焊上就摘不掉。
//
// 下面只列模板**没有**的增量。运行时依赖对照(模板已覆盖,2026-08-07 实测过确认页清单):
//   @ 消息事件 / message.list、get 拉历史 / message.reply、delete 回话题撤卡片 /
//   image、file.create 与 messageResource.get 传取附件 / chatMembers.get 查群成员 /
//   im.message.receive_v1 接收消息事件 / card.action.trigger 密钥卡片回调 /
//   messageReaction.create 贴回执表情(2026-08-08 现网实测已覆盖)
//
// feishu.ts / bot.ts 新调接口报 99991672 的话,把错误消息里点名的 scope 加进下面数组
// (照着 "One of the following scopes is required: [...]" 那串抄,比查文档准;名字写错
// 飞书**不报错**,确认页会静默丢掉那条),再重跑 `npm run register`,确认页选中现网应用。
const EXTRA_SCOPES = [
  'im:message.group_msg', // 没 @ 它的群消息(免 @ 接话的前提)——模板清单里没有这项
]

const addons: AppAddons = {
  preset: true,
  scopes: { tenant: EXTRA_SCOPES },
}

// 无色渲染下终端背景就是天然静区,这 2 格只为把周围的提示文字推开一点
const QUIET = 2

/**
 * 无色半块渲染:只用 ▀▄█ 和空格,**不设任何 ANSI 颜色**——颜色交给终端。深色主题下码
 * 自动反色(飞书扫码器认反色,2026-08-08 真机实测;这个码的消费者也只有手机飞书),
 * 浅色主题下是正色,两个方向整片终端背景都是天然静区。
 * 不涂色还把渲染缺陷良性化了:行距缝、字形不满格露出来的都是背景色,只会把模块削薄,
 * 不会添假特征;之前涂白底的方案里,同样的缺陷是白区里的假暗线,实测对比明显更差。
 * qrcode 库只当矩阵计算器,它自带的终端渲染器(静区写死 1 格、读选项的代码整段被注释、
 * 双黑用会被行距切碎的字形)不碰。EC 用 L:扫的是屏幕不是会磨损的印刷品,压版本要紧。
 * 宽度不够(要 size+4 列)返回空串——折行的码花屏还扫不出,不如只走链接。
 */
function renderQr(url: string): string {
  const qr = QRCode.create(url, { errorCorrectionLevel: 'L' })
  const size = qr.modules.size
  const total = size + QUIET * 2
  if (total > (process.stdout.columns ?? 80)) return ''
  const dark = (x: number, y: number): boolean =>
    x >= QUIET && y >= QUIET && x < QUIET + size && y < QUIET + size &&
    Boolean(qr.modules.data[(y - QUIET) * size + (x - QUIET)])
  let out = ''
  for (let y = 0; y < total; y += 2) {
    let line = ''
    for (let x = 0; x < total; x++) {
      const top = dark(x, y)
      const bottom = y + 1 < total && dark(x, y + 1)
      line += top ? (bottom ? '█' : '▀') : (bottom ? '▄' : ' ')
    }
    out += `${line}\n`
  }
  return out
}

/**
 * 确认链接要用**手机上的**飞书打开,而链接只有几分钟有效期,"弄到手机上"的摩擦是真实的。
 * 主路径:复制链接,在飞书里发给自己,手机上点开——不依赖终端渲染,SSH 里也走得通。
 * 二维码是 best-effort 的加速件,扫不出来不挡路。
 * **必须本地生成**:这是一条授权链接,谁拿到谁就能替你建应用,不能丢给在线二维码服务去画。
 */
function showConfirmLink(url: string, expireIn: number): void {
  let qr = ''
  try {
    qr = renderQr(url)
  } catch {
    // 画不出来不是错,链接才是主路径
  }
  console.log(`\n用手机上的飞书打开确认页,${Math.round(expireIn / 60)} 分钟内有效。最稳的走法:`)
  console.log('复制下面的链接,在飞书里发给自己,然后在手机上点开。')
  if (qr) {
    console.log('\n手机飞书「扫一扫」能认出下面这个码的话更快(扫不出来就走链接,不用纠结):\n')
    console.log(qr)
  }
  console.log(`  ${url}\n`)
  console.log('等待确认……')
}

function die(msg: string): never {
  console.error(`\n✗ ${msg}`)
  process.exit(1)
}

const ENV_PATH = path.resolve('.env')
const readEnv = (): Promise<string> => readFile(ENV_PATH, 'utf8').catch(() => '')

/**
 * 写 .env:过滤旧键再追加。值不经过正则/sed 替换,密钥里出现 `$&` 之类序列没有转义问题;
 * 临时文件带 600 建好再 rename,读的那侧任何时刻拿到的都是完整文件。
 */
async function envSet(pairs: Array<[key: string, value: string]>): Promise<void> {
  const kept = (await readEnv()).split('\n')
    .filter((line) => line !== '' && !pairs.some(([key]) => line.startsWith(`${key}=`)))
  const body = [...kept, ...pairs.map(([key, value]) => `${key}=${value}`)].join('\n') + '\n'
  await writeFile(`${ENV_PATH}.tmp`, body, { mode: 0o600 })
  await rename(`${ENV_PATH}.tmp`, ENV_PATH)
}

const previousId = (await readEnv()).match(/^FEISHU_BOT_ID=(.+)$/m)?.[1]

console.log('创建飞书应用,或在确认页选择已有应用(给它增量开通权限)……')

try {
  const result = await registerApp({
    addons,
    // appId、appPreset(名字/简介)、createOnly 都是刻意不发的:确认 URL 每多一段就抬高
    // 二维码一个版本,而这些在确认页上都有替代——名字自己填,新建还是选已有应用
    // 自己看清楚再点(选已有 = 增量开通权限,app_id 和 secret 都不变)
    onQRCodeReady({ url, expireIn }) {
      showConfirmLink(url, expireIn)
    },
    onStatusChange({ status }) {
      if (status === 'domain_switched') console.log('检测到 Lark 租户,已切换认证域名')
      if (status === 'slow_down') console.log('轮询被限流,已放慢')
    },
  })
  await envSet([['FEISHU_BOT_ID', result.client_id], ['FEISHU_BOT_SECRET', result.client_secret]])
  if (result.client_id === previousId) {
    console.log(`\n✅ 权限已更新(app_id ${result.client_id} 不变)。bot 在跑的话重启 npm start,新权限要重新取 token 才生效。`)
  } else {
    console.log(`\n✅ 应用已就绪(app_id ${result.client_id}),凭证已写进 .env(权限收到 600),终端上不打印。`)
  }
} catch (err) {
  const e = err as { code?: string; description?: string; message?: string }
  const hint = {
    access_denied: '你在确认页点了拒绝。',
    expired_token: '链接过期或等太久了,重跑一次。',
    abort: '被中断了。',
  }[e.code ?? '']
  die(`${e.code ? `(${e.code})` : ''}${hint ?? e.description ?? e.message ?? String(err)}`)
}
