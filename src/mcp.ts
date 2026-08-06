import { createSdkMcpServer } from '@anthropic-ai/claude-agent-sdk'
import type { McpSdkServerConfigWithInstance } from '@anthropic-ai/claude-agent-sdk'

// bot 进程内的工具组(feishu / followup / model)共用的三样东西。
// 各工具组只写自己的工具,server 怎么搭、结果怎么包、全名怎么拼都在这里,别再各写一份。

// SDK 没导出参数类型,从函数签名上取
type Tools = NonNullable<Parameters<typeof createSdkMcpServer>[0]['tools']>

/**
 * 一个工具组 = 一个进程内 MCP server,每次 query 现做(闭包捕获本轮的 chatId/threadId)。
 * **alwaysLoad 必须两处都写**,这是本文件存在的主要理由:
 * 传进 createSdkMcpServer 的那个才会给每个工具打上 _meta 标记,只写在 mcpServers 那层
 * 对 sdk 型 server 不生效——实测模型照样得先 ToolSearch 才拿得到 schema,
 * 而发言工具藏在搜索后面,模型哪轮懒得搜就成了整轮不开口。进程内 server 常驻没什么代价。
 */
export function toolServer(name: string, tools: Tools): Record<string, McpSdkServerConfigWithInstance & { alwaysLoad: true }> {
  const server = createSdkMcpServer({ name, alwaysLoad: true, tools })
  return { [name]: { alwaysLoad: true, ...server } }
}

/** 工具在消息流里的全名(SDK 约定 mcp__<服务名>__<工具名>);agent.ts 要按它认工具,防改名失联 */
export const toolName = (server: string, tool: string): string => `mcp__${server}__${tool}`

/** 工具结果一律用文本回 */
export const textResult = (text: string) => ({ content: [{ type: 'text' as const, text }] })

const message = (err: unknown): string => (err instanceof Error ? err.message : String(err))

/**
 * 失败也回文本、不抛出:模型比代码更知道该跟群里怎么说,报错原样带出它才说得出哪儿不对。
 * 错误里有结构化信息的(飞书接口的 response.data)自己传 fmt。
 */
export const respond = (run: () => Promise<string>, fmt: (err: unknown) => string = message) =>
  run().then(textResult, (err: unknown) => textResult(`失败:${fmt(err)}`))
