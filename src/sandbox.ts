import { execFile as execFileCb, spawn } from 'node:child_process'
import { hash } from 'node:crypto'
import { existsSync, readFileSync } from 'node:fs'
import { mkdir, readdir, rename, stat, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { promisify } from 'node:util'
import type { SpawnedProcess, SpawnOptions as CliSpawnOptions } from '@anthropic-ai/claude-agent-sdk'

const execFile = promisify(execFileCb)

// 全仓库的口径:一个群 = 一个**沙箱**,由两半组成,都从 sandboxId 派生——
//   sandboxName(chatId)  机器那半边(Incus 起的一台 Debian,`incus list` 看得到)
//   sandboxDir(chatId)   宿主数据那半边(sandbox/<id>/,凭证正本 + 挂进机器的 ~/.claude)
// 机器那半边随时可以删了重建,数据那半边不受影响。别把这两半混着说。
// 另一个层次是 colima 提供的那台 Linux **虚拟机**:mac 上跑 Incus 守护进程用的宿主层,
// 全局一台、所有群共用,不是沙箱。
//
// 沙箱跑的是完整的 Linux 系统:有 init、文件系统天生持久,agent 自己 apt 装的东西会一直留着,
// 也不存在"镜像换代就得重建"这回事 —— 这是选 Incus 而不是 podman 的全部理由。
// 别为了"更像标准镜像"改回不可变那套,那会让每次升级 CLI 都把各群攒下来的环境清零。

const CLI = 'incus'
// 出厂镜像只在建沙箱那一次用。沙箱建好后自己演进,改这个值不会影响已有的群
const BASE_IMAGE = process.env.SANDBOX_BASE_IMAGE || 'images:debian/13'

/** agent 在沙箱内的身份与路径。provision.sh 和 system prompt 写死了同一份,改要一起改 */
const AGENT_HOME = '/home/agent'
export const WORKSPACE = `${AGENT_HOME}/workspace`
const AGENT_ID = '1000'

const PROVISION = path.resolve('provision.sh')
const CLI_VERSION: string = JSON.parse(readFileSync(
  path.resolve('node_modules/@anthropic-ai/claude-agent-sdk/package.json'), 'utf8',
)).claudeCodeVersion

// provision 脚本内容 + CLI 版本的联合指纹,记在沙箱配置里。任一变化就重跑 provision
// (它自身幂等,没变化时 0.1 秒)。沙箱永不重建,所以这是 CLI 升级的唯一入口
const STAMP_KEY = 'user.feishu-tag.provision'
const STAMP = `${hash('sha256', readFileSync(PROVISION), 'hex').slice(0, 12)}-${CLI_VERSION}`

const RETRY_MS = 5 * 60_000

const NAME_PREFIX = 'feishu-tag-'

/** 群沙箱 id,由 chatId 哈希得出,随时可重算。机器名和宿主目录名都从它派生 */
export function sandboxId(chatId: string): string {
  return hash('sha256', chatId, 'hex').slice(0, 12)
}

/** 沙箱机器那半边的名字。`incus list` 看到的名字去掉前缀就是 sandbox 下的目录名 */
function sandboxName(chatId: string): string {
  return `${NAME_PREFIX}${sandboxId(chatId)}`
}

// ── 沙箱数据那半边(宿主 sandbox/<id>/) ──────────────────────────────────────

/**
 * 本群凭证正本(secrets.ts)、待回访排期(followup.ts)和挂进机器当 `~/.claude` 的那份数据
 * 都在这儿。放在仓库目录下、且**仓库必须在 `$HOME` 之内**(ensureHostReady 会拦):
 * colima 只把宿主 `$HOME` 经 virtiofs 透进那台 Linux 虚拟机,incus 才挂得到。
 * 这样机器随时可以删了重建,会话记录、模型设置、长期记忆留在宿主这边不受影响。
 */
export const SANDBOX_ROOT = path.resolve('sandbox')
export const sandboxDir = (chatId: string): string => path.join(SANDBOX_ROOT, sandboxId(chatId))
const claudeDirOf = (id: string): string => path.join(SANDBOX_ROOT, id, 'claude')

/** 挂进沙箱当 `~/.claude` 的那个目录,宿主这半边。模型设置(settings.json,agent 自己改)也落在它下面 */
const claudeDir = (chatId: string): string => claudeDirOf(sandboxId(chatId))

/**
 * CLI 的会话记录落在 `~/.claude/projects/<按 cwd 生成的目录>/<sessionId>.jsonl`,
 * 而沙箱的 `~/.claude` 就是这个目录挂进去的,所以直接读宿主、不用进沙箱。
 * **全仓库只有这里知道这个布局**:目录名跟着 cwd 走,不猜,整棵 projects 扫一遍;
 * CLI 换了落盘位置只改这一个函数,别再在别处拼这条路径(漏改的那处会静默返回"没有会话")。
 */
async function sessionRecords(id: string): Promise<{ dir: string; files: string[] }> {
  const dir = path.join(claudeDirOf(id), 'projects')
  const all = await readdir(dir, { recursive: true }).catch(() => [])
  return { dir, files: all.filter((f) => f.endsWith('.jsonl')) }
}

/**
 * 这个话题的会话记录在不在(sessionId 由 agent.ts 从 threadId 派生)。
 * 只认 `projects/<cwd 目录>/<sessionId>.jsonl` 这一层:再深一层的
 * `<sessionId>/subagents/agent-*.jsonl` 是子 agent 的记录,算活动(lastActiveAt 收)但不是会话本身。
 */
export async function hasSessionRecord(chatId: string, sessionId: string): Promise<boolean> {
  const { files } = await sessionRecords(sandboxId(chatId))
  return files.some((f) => f.split(path.sep).length === 2 && path.basename(f) === `${sessionId}.jsonl`)
}

/**
 * 群数据文件的原子写:临时文件权限备齐再 rename,读的那一侧(CLI、手改的人)
 * 任何时刻拿到的都是完整文件。凭证、模型设置、回访排期都走它,别再各写一份
 * ——写一半崩掉留下的截断文件,读回来时和"没有这个文件"分不开。
 */
export async function writeAtomic(file: string, body: string, mode?: number): Promise<void> {
  const dir = path.dirname(file)
  await mkdir(dir, { recursive: true, mode: 0o700 })
  const tmp = path.join(dir, `.tmp-${path.basename(file)}`)
  await writeFile(tmp, body, mode === undefined ? undefined : { mode })
  await rename(tmp, file)
}

/**
 * 宿主 `sandbox/<id>/claude` 挂进沙箱当 `~/.claude` 的那个 disk device。
 * **宿主 uid 怎么落进沙箱,两个平台的结论正好相反**,别把一边的搬到另一边:
 * - mac(经 colima):走 virtiofs,**不做 uid 映射**——目录在沙箱里属主显示成 root/nobody
 *   (跟宿主对不上)、权限位也不起作用,agent 照样读写,因为 virtiofs 根本不查。
 *   所以别在上面 chown(不生效),也别指望用权限做"agent 只读"那种语义;
 *   更别给它设 `shift=true`:virtiofs 没有 idmapped mount 能力,设了设备就再也起不来。
 * - Linux(原生):非特权沙箱有真的 uid 映射、权限位照常生效。宿主目录属主是跑 bot 的那个人,
 *   得靠 CLAUDE_IDMAP 映到 agent 头上,否则 agent 看到的是 nobody、一个字节都写不进去。
 */
const CLAUDE_DEVICE = 'claude'

/**
 * Linux 上把宿主的 uid/gid 映成沙箱里的 agent(见 CLAUDE_DEVICE);mac 是 null,
 * 那条路不需要、设了反而出事。实测过的三件事,别凭直觉改:
 * - **Incus 不会自动 idmap**。不设这个,目录在沙箱里就是 `65534:65534`,
 *   连沙箱内的 root 都读不了,agent 一个字节写不进去。
 * - **别图省事写 `both <uid> <agent>`**:宿主的 uid 和 gid 不一定相等(等于只映了 uid),
 *   另一半会掉成 nobody,agent 建的文件在宿主那边属主就不对了。uid/gid 各映一行。
 * - `raw.idmap` 只在沙箱**启动时**读一次,改了必须重启才生效。
 */
const IDMAP_KEY = 'raw.idmap'
const CLAUDE_IDMAP = process.platform === 'linux'
  ? `uid ${process.getuid!()} ${AGENT_ID}\ngid ${process.getgid!()} ${AGENT_ID}`
  : null

/** 给 CLI 的模型令牌;index.ts 的启动校验和 secrets.ts 的注入都认这份 */
export const authEnv = {
  ANTHROPIC_API_KEY: process.env.ANTHROPIC_API_KEY,
  CLAUDE_CODE_OAUTH_TOKEN: process.env.CLAUDE_CODE_OAUTH_TOKEN,
}

// 保留前缀:模型凭证也走沙箱配置注入,密钥卡片要是能写同名变量就会把它们覆盖掉。
// GITHUB_ 故意不在名单里,GITHUB_TOKEN 正是要能走密钥卡片配
export const ENV_PASS = ['ANTHROPIC_', 'CLAUDE_']

// ── 沙箱生命周期 ───────────────────────────────────────────────────────────

// 三张表都按 sandboxId 索引而不是 chatId:空闲回收那边只拿得到机器名,chatId 哈希不回去,
// 两边得认同一把钥匙才互斥得上
const inflight = new Map<string, Promise<void>>()
const failed = new Map<string, { at: number; err: Error }>()
/** 空闲回收正在停的沙箱。ensure 要排在它后面,不然 start 和 stop 会打架 */
const stopping = new Map<string, Promise<unknown>>()

/** 保证群沙箱已创建、在运行、且 provision 到位。失败直接抛错,错误信息里带修复指引 */
export function ensureSandbox(chatId: string): Promise<void> {
  const id = sandboxId(chatId)
  const f = failed.get(id)
  if (f && Date.now() < f.at + RETRY_MS) return Promise.reject(f.err)
  let p = inflight.get(id)
  if (!p) {
    // 从这行到 inflight.set 之间不能插入 await:stopIfIdle 那边靠"同步检查 inflight + 同步登记
    // stopping"和这里配对,中间只要有一次让权,就可能停掉一台正要开工的机器
    p = (stopping.get(id) ?? Promise.resolve())
      .catch(() => {})
      .then(() => doEnsure(chatId))
      .then(() => void failed.delete(id))
      .catch((err) => {
        failed.set(id, { at: Date.now(), err })
        console.error(`[sandbox] 群沙箱就绪失败 chat=${chatId}:`, err.message ?? err)
        throw err
      })
      .finally(() => inflight.delete(id))
    inflight.set(id, p)
  }
  return p
}

interface Sandbox { status: string; config: Record<string, string>; devices: Record<string, unknown> }

/** 沙箱现状;不存在返回 null。一次 query 把状态、配置和设备都拿回来 */
async function sandboxInfo(name: string): Promise<Sandbox | null> {
  const r = await execFile(CLI, ['query', `/1.0/instances/${name}`]).catch(() => null)
  if (!r) return null
  const j = JSON.parse(r.stdout)
  return { status: j.status, config: j.config ?? {}, devices: j.devices ?? {} }
}

const addClaudeDevice = (name: string, dir: string): Promise<unknown> => execFile(CLI, [
  'config', 'device', 'add', name, CLAUDE_DEVICE, 'disk', `source=${dir}`, `path=${AGENT_HOME}/.claude`,
])

/**
 * 给还没挂过的老沙箱补挂数据目录。挂上去会把沙箱里原来的 `~/.claude` **整个遮住**
 * (数据还在沙箱文件系统里,但从此看不见,会话记录当场断档),
 * 所以宿主这边还空着就说明没搬过,当场拦下并给出搬迁命令,别让上下文静默消失。
 */
async function attachClaudeDir(name: string, dir: string): Promise<void> {
  const inside = await execFile(CLI, [
    'exec', name, '-T', '--', 'sh', '-c', `ls -A ${AGENT_HOME}/.claude 2>/dev/null | head -1`,
  ]).then((r) => r.stdout.trim(), () => '')
  if (inside && !(await readdir(dir).catch(() => [])).length) {
    throw new Error(
      `沙箱 ${name} 里已有 ~/.claude,但宿主 ${dir} 还是空的,直接挂载会把它遮住。先搬出来:\n` +
      `  incus exec ${name} -T -- tar -C ${AGENT_HOME}/.claude -cf - . | tar -C ${dir} -xf -\n` +
      `  incus file pull ${name}${WORKSPACE}/CLAUDE.md ${path.join(dir, 'CLAUDE.md')}  # 长期记忆换到 ~/.claude 下了`,
    )
  }
  await addClaudeDevice(name, dir)
}

/**
 * Docker 共存:Docker 会把 iptables 的 FORWARD 默认策略改成 DROP,而 nftables 语义下
 * incus 自己表里的 accept 压不过别的表里的 drop——沙箱的 IPv4 转发全被宿主丢弃。
 * IPv6 不受影响,症状因此很迷惑:有 AAAA 的站能通(apt 常常没事),其余全部连接超时。
 * 修法是 Incus 官方口径:往 Docker 留给用户的 DOCKER-USER 链插 incus 网桥的双向放行
 * (docker 重启不清这条链,但机器重启会)。规则丢了只在沙箱要跑时咬人,所以在每次
 * ensure 断言,本进程补成功过一次就不再查;docker 事后才装也一样被兜住。
 * sudo 白名单由 install.sh 写在 /etc/sudoers.d/feishu-tag,只放行这四条**逐字匹配**的
 * 命令——iptables 路径或参数改了必须同步改那边,对不上 sudo 会拒。
 * 失败只告警不拦路:规则可能已被管理员用别的方式放行,-C 在 sudo 被拒时也区分不出
 * "规则已在",拦了反而误伤。
 */
const IPTABLES = '/usr/sbin/iptables'
let dockerCoexistDone = process.platform !== 'linux'
let dockerCoexistWarned = false
async function ensureDockerCoexist(): Promise<void> {
  if (dockerCoexistDone || !existsSync('/var/run/docker.sock')) return
  const nets = await execFile(CLI, ['query', '/1.0/networks?recursion=1'])
    .then((r) => JSON.parse(r.stdout) as { name: string; type: string; managed: boolean }[], () => [])
  const bridge = nets.find((n) => n.managed && n.type === 'bridge')?.name
  if (!bridge) return
  for (const flag of ['-i', '-o']) {
    const rule = ['DOCKER-USER', flag, bridge, '-j', 'ACCEPT']
    if (await execFile('sudo', ['-n', IPTABLES, '-C', ...rule]).then(() => true, () => false)) continue
    try {
      await execFile('sudo', ['-n', IPTABLES, '-I', ...rule])
      console.log(`[sandbox] 已补 Docker 共存放行:iptables -I ${rule.join(' ')}`)
    } catch (err) {
      if (!dockerCoexistWarned) {
        dockerCoexistWarned = true
        console.error('[sandbox] 检测到 Docker,但补不上 DOCKER-USER 的放行,沙箱 IPv4 可能被 ' +
          `FORWARD DROP 闷死(症状:沙箱里只有 IPv6 站能通)。重跑一次 ./install.sh 配 sudo 白名单。原始错误:${(err as Error).message ?? err}`)
      }
      return
    }
  }
  dockerCoexistDone = true
}

/**
 * 保证本群沙箱存在、在跑、挂好数据目录、provision 到位。
 * provision 幂等且秒级,指纹对得上就整个跳过。
 */
async function doEnsure(chatId: string): Promise<void> {
  await ensureDockerCoexist()
  const name = sandboxName(chatId)
  const dataDir = claudeDir(chatId)
  await mkdir(dataDir, { recursive: true, mode: 0o700 })
  let inst = await sandboxInfo(name)
  if (!inst) {
    console.log(`[sandbox] 新建群沙箱 ${name}(首次要拉基础镜像)…`)
    // create → 配置 → 挂盘 → start 而不是 launch:
    // 挂载点和 uid 映射都要赶在沙箱第一次跑 provision 之前就位
    await run(CLI, ['create', BASE_IMAGE, name])
    // 嵌套全开:沙箱里能再起一层容器(agent 装 Docker、开发本项目起探针沙箱都靠它)。
    // 内层要跑 Incus 还得把内层 /etc/subuid 缩窄(root:1000000:1000000 实测可用):
    // 外层映射默认 10 亿宽、从 1000000 起,内层默认段也是 10 亿,错着位装不进去。
    // 别设 security.idmap.size 去"配合"内层:6.0 无视它,7.x 真收窄反而埋雷。
    // 只在新建时设:存量沙箱手动补同一个键即可,和 raw.idmap 一样下次启动才生效
    await execFile(CLI, ['config', 'set', name, 'security.nesting=true'])
    if (CLAUDE_IDMAP) await execFile(CLI, ['config', 'set', name, `${IDMAP_KEY}=${CLAUDE_IDMAP}`])
    await addClaudeDevice(name, dataDir)
    await execFile(CLI, ['start', name])
    inst = await sandboxInfo(name)
  } else {
    // 换了跑 bot 的用户、或从 mac 上的备份导过来,idmap 就对不上了,重启补正
    if (CLAUDE_IDMAP && inst.config[IDMAP_KEY] !== CLAUDE_IDMAP) {
      await execFile(CLI, ['config', 'set', name, `${IDMAP_KEY}=${CLAUDE_IDMAP}`])
      if (inst.status === 'Running') await execFile(CLI, ['restart', name])
    }
    if (inst.status !== 'Running') await execFile(CLI, ['start', name])
    if (!(CLAUDE_DEVICE in inst.devices)) await attachClaudeDir(name, dataDir)
  }
  if (inst?.config[STAMP_KEY] !== STAMP) {
    console.log(`[sandbox] 初始化/升级沙箱环境 ${name}…`)
    await execFile(CLI, ['file', 'push', PROVISION, `${name}/root/provision.sh`, '--mode', '755'])
    await run(CLI, ['exec', name, '-T', '--', 'sh', '/root/provision.sh', CLI_VERSION])
    // 指纹最后才写:中途失败下条消息会重跑
    await execFile(CLI, ['config', 'set', name, `${STAMP_KEY}=${STAMP}`])
  }
}

// ── 进出沙箱 ───────────────────────────────────────────────────────────────

// exec 以 agent 身份跑时必须显式给 HOME:incus exec --user 只换 uid,
// 不设 HOME/USER/LOGNAME,而 claude CLI 在 HOME 为空时会**静默挂住**(不报错、不退出)。
// 这两个值不敏感,走命令行无所谓;真正的凭证走沙箱配置(见 secrets.ts)
const AS_AGENT = ['--user', AGENT_ID, '--group', AGENT_ID, '--env', `HOME=${AGENT_HOME}`, '--env', 'USER=agent']

/**
 * 把 CLI 起进群沙箱(SDK 的 spawnClaudeCodeProcess 钩子):
 * exec 进沙箱,cwd 固定在工作区,stream-json 原样走 exec 的 stdio。
 * **必须带 -T**:否则 incus 会分配 pty,流会变行缓冲还带回显。
 * signal 中止宿主侧客户端时,沙箱内的进程会跟着被杀(与 ssh 的 SIGHUP 同义),不留孤儿。
 */
export function spawnAgentCli(chatId: string, opts: CliSpawnOptions): SpawnedProcess {
  // 凭证走沙箱配置,opts.env 一概不用;这里只对 SDK 新传进来的变量告警,免得它悄悄失效
  for (const k of Object.keys(opts.env)) {
    if (k !== 'PATH' && k !== 'HOME' && !ENV_PASS.some((p) => k.startsWith(p))) {
      console.warn(`[sandbox] env 未注入沙箱(要用就写进 secrets.ts 的注入路径): ${k}`)
    }
  }
  return spawn(CLI, [
    'exec', sandboxName(chatId), '-T', '--cwd', WORKSPACE, ...AS_AGENT,
    '--', 'claude', ...opts.args,
  ], {
    stdio: ['pipe', 'pipe', 'pipe'],
    // 只给 incus 客户端自己要用的;bot 的其他环境变量(飞书密钥等)不进沙箱
    env: { PATH: process.env.PATH, HOME: process.env.HOME },
    signal: opts.signal,
  })
}

/** 在群沙箱里以 agent 身份跑一条一次性命令,拿标准输出。沙箱不在或命令失败都抛错 */
export async function execInSandbox(chatId: string, argv: string[]): Promise<string> {
  const { stdout } = await execFile(CLI, [
    'exec', sandboxName(chatId), '-T', ...AS_AGENT, '--', ...argv,
  ], { maxBuffer: 64 * 1024 * 1024 })
  return stdout
}

/**
 * 沙箱内的文件拉到宿主。路径解析发生在沙箱内,软链指不出沙箱,不用再防越界。
 * 这一步没法省成流式:上传飞书要经 form-data 算 Content-Length,而它只认
 * 能 fs.stat 出大小的文件流(见 feishu.ts 的 sendAttachment)。
 */
export async function copyFromSandbox(chatId: string, src: string, dest: string): Promise<void> {
  await execFile(CLI, ['file', 'pull', `${sandboxName(chatId)}${src}`, dest])
}

// ── 凭证注入(值走 stdin,不进宿主 ps) ──────────────────────────────────────

/** 沙箱上当前注入的环境变量。一次 query 拿全,给 secrets.ts 做差异比对 */
export async function readSandboxEnv(chatId: string): Promise<Record<string, string>> {
  const inst = await sandboxInfo(sandboxName(chatId))
  if (!inst) return {}
  const out: Record<string, string> = {}
  for (const [k, v] of Object.entries(inst.config)) {
    if (k.startsWith('environment.')) out[k.slice('environment.'.length)] = v
  }
  return out
}

/**
 * 注入一个环境变量。值经 stdin 传,不出现在宿主的 ps 里
 * (`config set <沙箱> <键> -` 这种写法 incus 会警告语法过时,但只有它能读 stdin;
 * 换成 `键=值` 就把凭证暴露在命令行上了)。传 null 删除。
 * 注入立即对后续 exec 生效,不用重启沙箱;沙箱重启后依然在。
 * Incus 不接受带换行的值,会显式报错——写入端已经拦住了(见 secrets.ts)。
 */
export async function setSandboxEnv(chatId: string, key: string, value: string | null): Promise<void> {
  const name = sandboxName(chatId)
  if (value === null) {
    await execFile(CLI, ['config', 'unset', name, `environment.${key}`])
    return
  }
  await new Promise<void>((resolve, reject) => {
    const p = spawn(CLI, ['config', 'set', name, `environment.${key}`, '-'], { stdio: ['pipe', 'ignore', 'pipe'] })
    let err = ''
    p.stderr.on('data', (d) => { err += d })
    p.on('error', reject)
    p.on('exit', (code) => (code === 0 ? resolve() : reject(new Error(`注入 ${key} 失败:${err.trim().slice(0, 200)}`))))
    p.stdin.end(value)
  })
}

// ── 空闲回收 ───────────────────────────────────────────────────────────────
//
// agent 起的后台进程(dev server、跑飞的构建)不随 claude 退出而结束:incus exec 断开只杀它直接
// 起的那一个进程,孙子进程被沙箱里的 systemd 收养接着跑。停机是唯一清得干净的办法,而且只丢进程
// ——挂载的 ~/.claude、沙箱配置里的环境变量和 provision 指纹、装过的软件都在,start 回来照旧。
// 判据只能用宿主侧 session 文件的 mtime:Incus 的 last_used_at 实测等于创建时间,跟用没用过无关。

/** 非正数(含没设成数字)= 关掉回收。这个值进了 system prompt(见 agent.ts),改了 agent 的说法跟着变 */
export const IDLE_STOP_MIN = Math.max(0, Number(process.env.SANDBOX_IDLE_STOP_MINUTES ?? 60))
const REAP_TICK_MS = 10 * 60_000

/**
 * 该群最后一次 agent 活动的时刻:CLI 每轮都写 session 文件,取最新的 mtime。
 * 一次都没跑过就是 0 = 空闲很久,停掉正合适;真在开工的头几秒还没写出文件,那几秒靠三道判定兜。
 */
async function lastActiveAt(id: string): Promise<number> {
  const { dir, files } = await sessionRecords(id)
  let newest = 0
  for (const f of files) {
    const s = await stat(path.join(dir, f)).catch(() => null)
    if (s && s.mtimeMs > newest) newest = s.mtimeMs
  }
  return newest
}

/** 正在跑的群沙箱机器名。按 incus 实况扫,不依赖 bot 知道有哪些群,重启后第一轮就收得干净 */
async function runningSandboxes(): Promise<string[]> {
  const { stdout } = await execFile(CLI, ['list', '--format=csv', '-c', 'ns'])
  return stdout.split('\n')
    .filter((l) => l.startsWith(NAME_PREFIX) && l.endsWith(',RUNNING'))
    .map((l) => l.slice(0, l.indexOf(',')))
}

async function stopIfIdle(name: string, isBusy: (id: string) => boolean): Promise<void> {
  const id = name.slice(NAME_PREFIX.length)
  if (inflight.has(id) || stopping.has(id) || isBusy(id)) return
  const idleMs = Date.now() - await lastActiveAt(id)
  if (idleMs < IDLE_STOP_MIN * 60_000) return
  // bot 重启后 isBusy 表是空的,机器里可能还留着上一条命的回合,再问一句沙箱自己
  const busy = await execFile(CLI, ['exec', name, '-T', '--', 'pgrep', '-x', 'claude']).then(() => true, () => false)
  if (busy) return

  // 以下三行同步执行、中间不能有 await:和 ensureSandbox 里同步 set inflight 的那段配对,
  // 让"判定空闲"和"登记在停"之间插不进一条新消息,否则会把正要开工的机器停掉
  if (inflight.has(id) || isBusy(id)) return
  const p = execFile(CLI, ['stop', name])
  stopping.set(id, p)

  console.log(`[sandbox] 空闲 ${Math.round(idleMs / 60_000)} 分钟,停机回收 ${name}(数据不受影响,下条消息自动拉起)`)
  await p.catch((err) => console.error(`[sandbox] 停机失败 ${name}:`, err.message ?? err))
  stopping.delete(id)
}

/**
 * 空闲回收的定时器。isBusy 由 index.ts 注入(agent.ts 那张活会话表),免得 sandbox.ts 反向依赖它
 * ——和 startFollowupScheduler 同一个接线法。启动时先扫一遍:重启多半是部署,顺手清掉上一条命的残留。
 */
export function startIdleReaper(isBusy: (id: string) => boolean): void {
  if (!IDLE_STOP_MIN) {
    console.log(`[sandbox] 空闲回收已关闭(SANDBOX_IDLE_STOP_MINUTES=${process.env.SANDBOX_IDLE_STOP_MINUTES})`)
    return
  }
  const tick = async (): Promise<void> => {
    try {
      for (const name of await runningSandboxes()) await stopIfIdle(name, isBusy)
    } catch (err) {
      console.error('[sandbox] 空闲回收扫描失败:', err)
    }
  }
  void tick()
  setInterval(tick, REAP_TICK_MS).unref()
}

// ── 启动预检 ───────────────────────────────────────────────────────────────

/** 输出直通控制台地跑一条长命令(拉镜像、装环境都要几十秒,没进度像卡死) */
function run(cmd: string, args: string[]): Promise<void> {
  return new Promise((resolve, reject) => {
    const p = spawn(cmd, args, { stdio: 'inherit' })
    p.on('error', reject)
    p.on('exit', (code) => (code === 0 ? resolve() : reject(new Error(`${cmd} ${args.join(' ')} 退出码 ${code}`))))
  })
}

/**
 * 启动检查。能自动补的就自动补(mac 上的 colima 虚拟机),补不了的当场退出并给指引。
 * incus 的守护进程只跑在 Linux 上:Linux 就是本机那个,mac 上由 colima 提供那台 Linux 虚拟机。
 * 这是全仓库唯一按平台分叉的地方,别的模块只管调 incus 客户端。
 */
export async function ensureHostReady(): Promise<void> {
  const fatal = (msg: string) => {
    console.error(msg)
    process.exit(1)
  }
  const mac = process.platform === 'darwin'
  if (!mac && process.platform !== 'linux') {
    fatal(`不支持的平台 ${process.platform}:沙箱靠 Incus,只有 Linux(原生)和 macOS(经 colima)两条路`)
  }
  // 沙箱数据目录要挂进沙箱当 ~/.claude,而 colima 只把宿主 $HOME 透进虚拟机。
  // 仓库放在别处的话 incus 挂不到这个路径,而且是建沙箱时才炸,所以启动就拦。
  // Linux 没有虚拟机这一层,incus 直接挂宿主路径,放哪都行
  const home = process.env.HOME
  if (mac && (!home || !SANDBOX_ROOT.startsWith(`${home}${path.sep}`))) {
    fatal(`仓库必须放在 ${home ?? '$HOME'} 之下(当前 ${process.cwd()}):` +
      'sandbox 目录要挂进群沙箱,而 colima 只把 $HOME 经 virtiofs 透进那台 Linux 虚拟机')
  }
  await execFile(CLI, ['version']).catch(() => fatal(mac
    ? '未找到 incus 客户端:brew install colima incus'
    : '未找到 incus:装法见 https://linuxcontainers.org/incus/docs/main/installing/'))

  if (mac) {
    const status = await execFile('colima', ['status']).then((r) => r.stdout + r.stderr, () => '')
    if (!status.includes('running')) {
      console.log('[sandbox] colima 未运行,正在启动(首次要建虚拟机,几分钟)…')
      await run('colima', ['start', '--runtime', 'incus']).catch((e) => fatal(`colima 启动失败:${e.message}`))
    } else if (!status.includes('incus')) {
      fatal('colima 正在运行,但 runtime 不是 incus:colima stop && colima start --runtime incus')
    }
  }
  await execFile(CLI, ['query', '/1.0']).catch(() => fatal(mac
    ? 'incus 服务端不可达:colima restart 之后重试'
    : 'incus 服务端不可达:确认守护进程在跑(systemctl status incus),且当前用户在 incus-admin 组里(加完组要重新登录)'))

  // incus 刚装完是没有存储池的,要跑一次 incus admin init。不拦的话要等某个群第一次说话、
  // 建沙箱时才炸,而且报错看不出是这个原因。colima 的 incus 是配好的,不用查
  if (!mac) {
    const pools = await execFile(CLI, ['query', '/1.0/storage-pools'])
      .then((r) => JSON.parse(r.stdout) as unknown[], () => [])
    if (!pools.length) fatal('incus 还没初始化(一个存储池都没有):先跑一次 incus admin init')
  }
}
