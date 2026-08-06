import { readFile } from 'node:fs/promises'
import path from 'node:path'
import { authEnv, ENV_PASS, readSandboxEnv, sandboxDir, setSandboxEnv, writeAtomic } from './sandbox.ts'

// 第三方服务凭证(Sentry token、GITHUB_TOKEN 等)。**一群一份,没有跨群共享的那一份**:
// 凭证的授权边界就是群,一处配置多处生效等于替别的群做主。正本是宿主
// sandbox/<id>/secrets.env(密钥卡片写,也能手改),真正生效靠同步进群沙箱的配置
// (值经 stdin 注入,不进宿主 ps,见 sandbox.ts)。
// 之所以留着宿主正本而不是直接以沙箱配置为准:要能手改,而且沙箱被清掉重建时凭证不用重配一遍。
// 注意:agent 读得到 = 模型说得出,只放愿意让群里 agent 直接用的凭证。

// 凭证文件在 sandbox/<id>/ 下、和 claude/ 平级:挂进沙箱的只有 claude/,凭证文件一个都不进去。
// 目录名就是沙箱名去掉 feishu-tag- 前缀,运维时 `incus list` 看到的名字直接对得上
const chatEnvFile = (chatId: string): string => path.join(sandboxDir(chatId), 'secrets.env')

const HEADER = '# feishu-tag 服务凭证(见 src/secrets.ts):会被同步进群沙箱的环境变量。' +
  '\n# 一行一条 NAME=值,值原样取到行尾(引号/$/# 都不解析),但**不能换行**;手改保存即生效。'

// 保留名单。PATH/HOME 会打破沙箱环境;ENV_PASS 是模型凭证的前缀,撞名会顶掉它们
const BLOCKED_EXACT = new Set(['PATH', 'HOME', 'USER'])

/** 变量名合法性。合法返回 null,否则返回一句人话 */
export function secretNameError(k: string): string | null {
  if (!/^[A-Za-z_]\w*$/.test(k)) return `变量名不合法(只能字母数字下划线,不能数字开头):${k}`
  if (BLOCKED_EXACT.has(k)) return `${k} 是保留变量名(会打破沙箱环境)`
  if (ENV_PASS.some((p) => k.startsWith(p))) {
    return `${k} 用了保留前缀(${ENV_PASS.join('/')}),会和模型凭证撞名`
  }
  return null
}

/** 解析 dotenv:一行一条,只切第一个 =,值原样取到行尾 */
function parseEnv(text: string): Record<string, string> {
  const out: Record<string, string> = {}
  for (const line of text.split('\n')) {
    if (!line || line.startsWith('#')) continue
    const i = line.indexOf('=')
    if (i <= 0) continue
    out[line.slice(0, i)] = line.slice(i + 1)
  }
  return out
}

async function readFileSecrets(file: string): Promise<Record<string, string>> {
  const all = parseEnv(await readFile(file, 'utf8').catch(() => ''))
  for (const k of Object.keys(all)) {
    const bad = secretNameError(k)
    if (bad) {
      console.warn(`[secrets] 跳过 ${path.basename(file)} 里的 ${k}:${bad}`)
      delete all[k]
    }
  }
  return all
}

/** 本群该有的全部注入项:模型凭证压轴,顶掉同名的服务凭证 */
async function desiredEnv(chatId: string): Promise<Record<string, string>> {
  const out = await readFileSecrets(chatEnvFile(chatId))
  for (const [k, v] of Object.entries(authEnv)) if (v) out[k] = v
  return out
}

/** 写入本群密钥(密钥卡片的落点,见 feishu.ts),同名覆盖,当场同步进沙箱 */
export async function setSecret(chatId: string, name: string, value: string): Promise<void> {
  const err = secretNameError(name)
  if (err) throw new Error(err)
  if (!value) throw new Error('值不能为空')
  // Incus 拒绝带换行的环境变量(会显式报错)。与其存个用不了的值,不如当场拒绝并给替代
  if (/[\r\n]/.test(value)) {
    throw new Error('值不能包含换行(环境变量存不下多行)。多行凭证(PEM 私钥、service account JSON)请先 base64 编码成一行再填,用的时候自己解码')
  }
  const file = chatEnvFile(chatId)
  const vals = await readFileSecrets(file)
  vals[name] = value
  const body = [HEADER, ...Object.entries(vals).map(([k, v]) => `${k}=${v}`)].join('\n') + '\n'
  await writeAtomic(file, body, 0o600)
  await setSandboxEnv(chatId, name, value)
}

/**
 * 本群能用的凭证变量名(不含值),拼进 system prompt 让 agent 知道有什么可用。
 * 现读现用:调用点在 refreshSecrets 之后(见 agent.ts),不缓存也不会看到旧值。
 */
export async function secretNames(chatId: string): Promise<string[]> {
  return Object.keys(await readFileSecrets(chatEnvFile(chatId)))
}

/**
 * 每条消息都调:把宿主正本同步进沙箱。
 * 差异比对后只动变化的那几个键,正常情况下一次 query、零次写。
 * 从不 reject,失败只记日志——凭证同步不上顶多是工具没认证,不该挡住回复。
 */
export async function refreshSecrets(chatId: string): Promise<void> {
  try {
    const [want, have] = await Promise.all([desiredEnv(chatId), readSandboxEnv(chatId)])
    for (const [k, v] of Object.entries(want)) {
      if (have[k] !== v) await setSandboxEnv(chatId, k, v)
    }
    for (const k of Object.keys(have)) {
      if (!(k in want)) await setSandboxEnv(chatId, k, null)
    }
  } catch (err) {
    console.error('[secrets] 同步失败:', err)
  }
}
