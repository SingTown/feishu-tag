# CLAUDE.md

飞书群聊机器人:长连接收群里 @ 消息 → Claude Agent SDK → agent 在**每群一个沙箱**里
经 `incus exec` 跑起来,回复由模型自己调 MCP 工具发进话题。

全仓库口径:隔离边界一律叫**沙箱**(`sandbox`)= 机器(Incus 起的 Debian,`feishu-tag-<id>`)
+ 宿主数据目录(`sandbox/<id>/`),两半都从 `sandboxId` 派生,机器可弃、数据留着。
只支持 Linux 部署(macOS 兼容 2026-08 删除,动因见 git log;Mac 上开发见下文专节)。

部署与运维见 `README.md`(面向使用者);设计沿革与取舍在 `git log`;本文件只写改代码会踩的坑。
**更细的坑单在各文件的头部和函数注释里,动哪个文件先读哪个**——留下来的注释都是
"不看会踩坑/改了会静默出事"的,跨文件约束在两端各写了一条。

## 命令

```bash
npm install           # npm(随 Node 自带),package-lock.json 为准;allowScripts.protobufjs=false
                      # 是审过的拒绝(postinstall 只打印版本建议),别改成 true
npm run typecheck     # 唯一的自动化验证(无测试、无 lint)
npm start             # 无构建:Node ≥22.18 原生 type stripping 直接跑 .ts
./install.sh          # 一键安装/升级(重跑即升级,README 的 curl | bash 也是它),坑单见文件头
npm run register      # 建应用;改了权限清单也是重跑它,确认页选中现网应用 = 增量开通
```

## 验证(typecheck 之外)

- **沙箱相关改动**只能真跑:起探针沙箱过一遍 `ensureSandbox` → 文件双向 →
  `spawnAgentCli` 真跑一轮 → `incus restart` 验持久 → `incus delete -f` 后再 `ensureSandbox`
  验 `sandbox/<id>/claude` 原样回来,用完连 `sandbox/<id>/` 一起删。
- **shell**:`sh -n provision.sh`、`bash -n install.sh`;apt/NodeSource 段语法检查保不住,
  得 Debian/Ubuntu 真机装一遍;开机自启段还要重启验自启、kill 主进程验拉起。

## 在 Mac 开发机上跑

bot 只能在 Linux 跑(`ensureHostReady` 平台检查直接退出),Mac 本地只有 `npm run typecheck`
走得通;运行和上面的"真跑"类验证都进 OrbStack 虚拟机 `feishu-tag-test`(Debian 13,
incus/Node 已装好,`.env` 正本也只在 VM 侧)。代码在 Mac 改,单向同步进去跑:

```bash
# 都在仓库根执行;orb 会把 Mac 当前目录映射进 VM,所以源路径写 ./ 即可
orb -m feishu-tag-test sh -c 'rsync -a --delete \
  --exclude=node_modules --exclude=sandbox --exclude=.env --exclude=.git --exclude=probe.ts \
  ./ ~/feishu-tag/'
orb -m feishu-tag-test sh -c 'cd ~/feishu-tag && npm install && npm start'
```

- **`--delete` 下这几个 exclude 一个都不能少**:`.env`(凭证)和 `sandbox/`(会话记录唯一
  副本)只存在 VM 侧,漏了就被 `--delete` 清掉;`node_modules` 有平台二进制,拷过去是坏的;
  `probe.ts` 是留在 VM 的沙箱探针脚本。
- **别在 `/mnt/mac`(virtiofs)路径下直接跑 bot**:`sandbox/<id>/claude` 挂进 Incus 后
  权限位/idmap 不生效——这正是当年删 macOS 兼容的原因之一,VM 原生盘的 `~/feishu-tag`
  副本就是为此存在。
- 凭证不往 Mac 同步(Desktop 常开着 iCloud 同步);`npm run register` 也在 VM 里跑,
  它读写的 `.env` 在那边。
- VM 没了就 OrbStack 新建一台 Debian:默认用户是 uid 501(跟随 macOS),过不了
  install.sh 的 uid/gid 1000 检查,先建 uid/gid 1000 的 sudo 用户,再用它跑
  `./install.sh` 走标准 Linux 路线。

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
register.ts 权限清单 + 扫码建应用,不在运行时链路
install.sh  一键安装器,仓库唯一的 bash:「Node 存在之前」的事 + 收尾开机自启
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
