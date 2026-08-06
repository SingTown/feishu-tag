import { readFile } from 'node:fs/promises'
import path from 'node:path'
import { tool } from '@anthropic-ai/claude-agent-sdk'
import type { ModelInfo, Query } from '@anthropic-ai/claude-agent-sdk'
import { z } from 'zod'
import { respond, toolServer } from './mcp.ts'
import { claudeDir, writeAtomic } from './sandbox.ts'

// 换模型 / 调 effort(思考投入)。模型名是**填错了不当场报错**的那种东西:错名字要到下一轮才发作,
// 之后每一轮都调不通,agent 自己也没法再开口改回来,只能管理员去宿主上手改文件。
// 所以不让 agent 直接改配置,走这个工具组。
//
// 把关的是 supportedModels 那份列表(CLI 报的、本账号 /model 里真能选的那几档,不是代码里写死的
// 白名单,不会随模型更新过期),每行还带着这个模型支持哪几档 effort,两样东西同一个来源。
// **别改成"交给 setModel 自己校验"**:实测它只查名字的形状,claude-opus-9、
// claude-sonnet-5-20990101 这种压根不存在的都放行(只有 opus-5 这类坏别名会被拦),
// 放行完照样每轮调不通——等于没拦。代价是钉某个具体版本(完整 id)这条路对 agent 关掉了,
// 那是管理员手改 sandbox/<id>/claude/settings.json 的事,list_models 会把手改的值标出来。
//
// 生效有两半,一次调用都做掉:对活会话调 setModel / applyFlagSettings(本轮后续回复立刻换过去,
// 不用等下一条消息),再把 model / effortLevel 写进沙箱的 ~/.claude/settings.json
// (一群一份、跨话题、活过沙箱重建)。

const SERVER_NAME = 'model'

type Level = 'low' | 'medium' | 'high' | 'xhigh'

/**
 * 能落盘的 effort 档。**max 故意不在里面**:SDK 的 Settings.effortLevel 类型就排除了它
 * (注释写明 max 是 session-scoped、永不写进配置文件),而本 bot 每轮回复结束 CLI 进程就没了,
 * 只在会话里生效 = 只活到本轮结束,下一轮悄悄变回去——给了等于骗人。
 */
const PERSISTABLE: Level[] = ['low', 'medium', 'high', 'xhigh']

/** 这个模型能选哪几档 effort(已剔掉 max);空数组 = 它不支持 effort */
function levelsOf(m: ModelInfo | undefined): Level[] {
  if (!m?.supportsEffort) return []
  const ok = m.supportedEffortLevels
  return ok ? PERSISTABLE.filter((l) => ok.includes(l)) : PERSISTABLE
}

/** 沙箱 ~/.claude/settings.json 的宿主这半边。CLI 起会话时读它决定用哪个模型、多大 effort */
const settingsFile = (chatId: string): string => path.join(claudeDir(chatId), 'settings.json')

/**
 * 整个 settings.json 读回来。文件不在 = 全走默认,是常态。
 * 内容坏了要抛而不是当空对象:这文件里还有 agent 自己攒的别的键,不能拿它们当人质。
 */
async function readSettings(chatId: string): Promise<Record<string, unknown>> {
  const text = await readFile(settingsFile(chatId), 'utf8').catch(() => '')
  if (!text.trim()) return {}
  const parsed: unknown = JSON.parse(text)
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('settings.json 不是一个 JSON 对象')
  return parsed as Record<string, unknown>
}

/** 只动 patch 里那几个键(null = 删掉),其余原样留着(agent 自己攒的键不能当人质) */
async function patchSettings(chatId: string, patch: Record<string, string | null>): Promise<void> {
  const obj = await readSettings(chatId)
  for (const [k, v] of Object.entries(patch)) {
    if (v === null) delete obj[k]
    else obj[k] = v
  }
  await writeAtomic(settingsFile(chatId), JSON.stringify(obj, null, 2) + '\n')
}

/** 当前落盘的模型与 effort;没配的是 null(= 走默认) */
async function current(chatId: string): Promise<{ model: string | null; effort: string | null }> {
  const s = await readSettings(chatId)
  const str = (v: unknown): string | null => (typeof v === 'string' && v ? v : null)
  return { model: str(s.model), effort: str(s.effortLevel) }
}

/** 把给进来的名字对到账号真实可用的那一行:大小写不敏感,别名和完整 id 都认 */
function match(models: ModelInfo[], want: string): ModelInfo | undefined {
  const w = want.trim().toLowerCase()
  return models.find((m) => m.value.toLowerCase() === w || m.resolvedModel?.toLowerCase() === w)
}

/** 没指定模型时实际生效的那一行 */
const defaultRow = (models: ModelInfo[]): ModelInfo | undefined => models.find((m) => m.value === 'default')

function render(models: ModelInfo[], cur: { model: string | null; effort: string | null }): string {
  const hit = cur.model ? match(models, cur.model) : undefined
  const lines = models.map((m) => {
    const alias = m.resolvedModel && m.resolvedModel !== m.value ? `(= ${m.resolvedModel})` : ''
    const noEffort = levelsOf(m).length ? '' : '(不支持 effort)'
    return `- ${m.value}${alias}:${m.displayName}${m.description ? ` —— ${m.description}` : ''}${noEffort}${m === hit ? ' ← 当前' : ''}`
  })
  // 配着一个列表里没有的名字,只可能是管理员手改配置改错了。这是本工具组挡不住的唯一入口,说出来
  if (!cur.model) lines.push('本群没有指定模型,用的是默认那个。')
  else if (!hit) lines.push(`本群配的是 ${cur.model},但它不在上面这份可用列表里,现在多半是调不通的,换一个。`)

  const levels = levelsOf(hit ?? defaultRow(models))
  lines.push(
    `当前 effort:${cur.effort ?? '默认'}` +
      (levels.length ? `(现在这个模型可选 ${levels.join(' / ')})` : '(现在这个模型不支持 effort)'),
  )
  return lines.join('\n')
}

/**
 * 工具组 + 活会话的控制通道。一个话题一份,由 agent.ts 在 CLI init 之后 attach。
 *
 * 可用列表在 attach 时就预取好,不在工具 handler 里现取:那会儿 CLI 正等着这次工具的结果,
 * 再往回问它一句是没验证过的用法,真要卡住就是整轮悬死(会话不结算、沙箱也一直算忙)。
 */
export function modelSession(chatId: string) {
  let q: Query | undefined
  let models: Promise<ModelInfo[]> | undefined

  const list = (): Promise<ModelInfo[]> =>
    models ?? Promise.reject(new Error('会话还没就绪,稍后再试'))

  const set = async (wantModel?: string, wantEffort?: string): Promise<string> => {
    if (!q) throw new Error('会话还没就绪,稍后再试')
    const rows = await list()
    const cur = await current(chatId)
    const m = wantModel?.trim().toLowerCase()
    const e = wantEffort?.trim().toLowerCase()
    if (!m && !e) return '没说要改什么:model 和 effort 至少给一个(要恢复默认就把那一项传 default)。'

    // 两项都先解析完再动手,别改了一半才发现另一半不合法。undefined = 这一项不动
    let modelPatch: string | null | undefined
    let row: ModelInfo | undefined // 这次调用之后实际生效的那一行,effort 按它校验
    if (m) {
      const hit = m === 'default' ? defaultRow(rows) : match(rows, m)
      if (!hit) {
        return `没有 ${wantModel} 这个模型,没做任何改动。本群能换的是:\n${render(rows, cur)}\n` +
          '只能换到这几档;要钉某个具体版本(完整模型 id)得管理员去改本群的 ~/.claude/settings.json。'
      }
      // 「default」那一档就是"不指定",删掉键让它走默认,别把 default 当模型名写进配置
      modelPatch = hit.value === 'default' ? null : hit.value
      row = hit
    } else {
      row = cur.model ? match(rows, cur.model) : defaultRow(rows)
    }

    let effortPatch: Level | null | undefined
    if (e) {
      const levels = levelsOf(row)
      if (e === 'default') {
        effortPatch = null
      } else if (e === 'max') {
        return 'effort 给不了 max:它按设计只在当前会话里有效、写不进配置,而你每轮回复结束进程就没了,' +
          `下一轮就变回去——设了等于骗人。要更用力就选 ${levels.length ? levels[levels.length - 1] : 'xhigh'}。`
      } else if (!levels.length) {
        return `${row?.value ?? '当前模型'} 不支持 effort,没做任何改动。要调 effort 先换一个支持的模型(见 list_models)。`
      } else {
        const lv = levels.find((l) => l === e)
        if (!lv) return `没有 ${wantEffort} 这档 effort,没做任何改动。${row?.value} 可选:${levels.join(' / ')}(或 default 恢复默认)。`
        effortPatch = lv
      }
    }

    // 先切活会话再落盘:切不动就不该写进去
    if (modelPatch !== undefined) await q.setModel(modelPatch ?? undefined)
    if (effortPatch !== undefined) await q.applyFlagSettings({ effortLevel: effortPatch })

    const resolved = row?.resolvedModel && row.resolvedModel !== row.value ? `,实际是 ${row.resolvedModel}` : ''
    const done: string[] = []
    if (modelPatch !== undefined) done.push(modelPatch === null ? '模型恢复默认' : `模型换成 ${row!.value}(${row!.displayName}${resolved})`)
    if (effortPatch !== undefined) done.push(effortPatch === null ? 'effort 恢复默认' : `effort 设为 ${effortPatch}`)

    const patch: Record<string, string | null> = {}
    if (modelPatch !== undefined) patch.model = modelPatch
    if (effortPatch !== undefined) patch.effortLevel = effortPatch
    try {
      await patchSettings(chatId, patch)
    } catch (err) {
      return `${done.join('、')},但没能写进本群配置(${err instanceof Error ? err.message : String(err)}):` +
        '本轮之后新起的会话会退回原来的设置,把这句原样告诉群里。'
    }
    return `${done.join('、')}:本轮后续回复起生效,本群所有话题的后续会话也都用它。`
  }

  // 换模型这事没人会先 ToolSearch,schema 得一直在 prompt 里(alwaysLoad 的坑见 mcp.ts)
  const server = toolServer(SERVER_NAME, [
    tool(
      'list_models',
      '列出本群能换的模型、标出正在用的那个,并报当前 effort(思考投入)和这个模型可选的档。' +
        '回答"你用的什么模型/能换成什么"用它;能换的就是这几档,群里报的名字不在其中时先列出来给对方选,' +
        '别自己往 set_model 里猜。',
      {},
      () => respond(async () => render(await list(), await current(chatId))),
    ),
    tool(
      'set_model',
      '给本群换模型、或调 effort(思考投入,越高越肯花时间想):本轮后续回复立刻生效,并写进本群配置,' +
        '之后所有话题、所有新会话都用它(一群一份,是给整个群改,不是只给当前话题改)。' +
        '两个参数各自独立:不传就不动那一项,传 default 就把那一项恢复默认,都不传会报错。' +
        '写了列表外的模型、或当前模型不支持的 effort 档,会直接失败并把可选项退回来——' +
        '设不出个用不了的,所以尽管试。别自己去改 ~/.claude/settings.json。',
      {
        model: z.string().optional().describe('list_models 里的那几档之一,如 opus / sonnet;default = 恢复默认;不传 = 不动模型'),
        effort: z.string().optional().describe('low / medium / high / xhigh(具体哪几档看 list_models);default = 恢复默认;不传 = 不动。给不了 max'),
      },
      ({ model, effort }) => respond(() => set(model, effort)),
    ),
  ])

  return {
    /** CLI init 之后调,把当轮会话交进来;重复调只认第一次 */
    attach(query: Query): void {
      if (q) return
      q = query
      models = query.supportedModels()
      // 标记成已处理,免得没人 await 时变成未捕获拒绝;原 promise 照样把错误带给工具
      models.catch((err) => console.error('[model] 取可用模型列表失败:', err))
    },
    server,
  }
}
