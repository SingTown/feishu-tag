# CLAUDE.md

飞书群聊机器人:长连接收群里 @ 消息 → Claude Agent SDK → agent 在**每群一个沙箱**里
经 `incus exec` 跑起来,回复由模型自己调 MCP 工具发进话题。

全仓库口径:隔离边界一律叫**沙箱**(`sandbox`)= 机器(Incus 起的 Debian,`feishu-tag-<id>`)
+ 宿主数据目录(`sandbox/<id>/`),两半都从 `sandboxId` 派生,机器可弃、数据留着。
mac 上 colima 那台叫**虚拟机**:跑 Incus 守护进程的宿主层,全局一台,不是沙箱。

部署与运维见 `README.md`(面向使用者);设计沿革与取舍在 `git log`;本文件只写改代码会踩的坑。
**更细的坑单在各文件的头部和函数注释里,动哪个文件先读哪个**——留下来的注释都是
"不看会踩坑/改了会静默出事"的,跨文件约束在两端各写了一条。

## 命令

```bash
npm install           # npm(随 Node 自带),package-lock.json 为准;allowScripts.protobufjs=false
                      # 是审过的拒绝(postinstall 只打印版本建议),别改成 true
npm run typecheck     # 唯一的自动化验证(无测试、无 lint)
npm start             # 无构建:Node ≥22.18 原生 type stripping 直接跑 .ts
./install.sh          # 一键安装(README 的 curl | bash 也是它),坑单见文件头
npm run register      # 建应用;改了权限清单也是重跑它,确认页选中现网应用 = 增量开通
```

## 验证(typecheck 之外)

- **沙箱相关改动**只能真跑:起探针沙箱过一遍 `ensureSandbox` → 文件双向 →
  `spawnAgentCli` 真跑一轮 → `incus restart` 验持久 → `incus delete -f` 后再 `ensureSandbox`
  验 `sandbox/<id>/claude` 原样回来,用完连 `sandbox/<id>/` 一起删。
- **平台分叉**(`ensureHostReady`、`CLAUDE_IDMAP`):uid 映射语义 mac 和 Linux **相反**
  (细节见 sandbox.ts),两个平台各跑一遍,一边过了不代表另一边过。
- **shell**:`sh -n provision.sh`、`bash -n install.sh`;apt/NodeSource 段语法检查保不住,
  得 Debian/Ubuntu 真机装一遍;开机自启段还要重启验自启、kill 主进程验拉起,两平台各一遍。

## 结构

```
index.ts    启动校验 → ensureHostReady → 收消息 → void replyWithAgent(不等回合跑完)
bot.ts      LarkChannel 薄门面,只管入方向;onMessage 是业务层唯一入口
agent.ts    按 threadId 复用会话;shouldHandle 准入(被 @ 一律收,没 @ 只在活话题收)
sandbox.ts  沙箱生命周期、spawnAgentCli、宿主↔沙箱通道、空闲停机回收、启动预检
mcp.ts      工具组共用的 server 搭法(alwaysLoad 的坑见文件头)
feishu.ts   feishu 工具组 + 图片内联预处理 + 密钥卡片回调
secrets.ts  第三方凭证:一群一份,正本 sandbox/<id>/secrets.env,值走 stdin 注入
followup.ts 定时回访:排期落盘,到点合成消息重新唤起 agent
model.ts    换模型/调 effort 工具组,落盘 + 对活会话即时生效
register.ts 权限清单 + 扫码建应用,不在运行时链路
install.sh  一键安装器,仓库唯一的 bash(按 bash 3.2 写):「Node 存在之前」的事 + 收尾开机自启
provision.sh 沙箱出厂初始化,在沙箱内跑;内容哈希+CLI 版本指纹变了自动重跑
```

## 编译器管不着的约束

- 新调飞书接口要同步 `register.ts` 的权限清单,漏了只会在运行时报 99991672
  (错误消息里写着缺哪个 scope)。
- `chatId → sandboxId`、`threadId → sessionId` 都是纯哈希派生、零状态,
  没有中心映射表,别新增。
- 沙箱会被空闲停机,别写"ensure 过一次就一直在"的代码:跨边界的事一律先 `ensureSandbox`。
- 宿主↔沙箱只共享 `sandbox/<id>/claude` ↔ `~/.claude` 这一处(bot 可直接 fs 读写),
  其余一律走 sandbox.ts 的通道函数,别在别处拼路径。

## TypeScript 约定

`erasableSyntaxOnly` + `verbatimModuleSyntax` + `allowImportingTsExtensions`:
不能用 enum / 参数属性 / namespace,类型导入必须 `import type`,相对导入**要带 `.ts` 后缀**。

## 不要碰

`.env` 和 `sandbox/`(凭证明文、会话记录、长期记忆、回访排期,都已 gitignore);
`sandbox/<id>/claude` 是各群对话历史的**唯一**副本,删了没处找回。
名字带 `feishu-tag-` 的沙箱机器也是真实运行数据:`incus delete` 会把该群工作区
和 agent 攒的环境一并清掉(会话记录在宿主,不受影响)。

## 协作约定

- **方案拍板前不写码**:讨论阶段只出分析和取舍,等明确的"执行"再动手。
- **架构精简,除非必要勿增实体**:新模块、新依赖、构建步骤、预防性设施默认不加,
  痛点等真实反馈出现再动。
- **策略交给模型,别写进代码**:接不接话、怎么回都是 prompt 里的判断,代码只守传输、
  凭证、崩溃兜底;加"@ 必回"这类代码底线是反方向。
- **凭证不经过模型**:一律不进对话、不进 prompt、不进 `ps`;写文档和引导流程同样适用,
  确认配没配上用 `grep -c`,不读值。
- **注释只留"不看会踩坑"的**:沿革、权衡记录进 commit message,不进代码。
- **commit 用 [Conventional Commits](https://www.conventionalcommits.org)**:
  `<type>(<scope>): <中文描述>`,scope 用模块名,破坏性改动 type 后加 `!`;
  正文是正式文档:中文,写清起因、取舍、怎么验证的、知情代价。
