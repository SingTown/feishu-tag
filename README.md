# feishu-tag

飞书群里的 AI 助理(名字建应用时自己起,下面拿 **bot** 举例)。群里 @ 它说一句,
它把活干完再回来——回答发进**话题(分支)**,不刷屏。

> **@bot** 官网首页在手机上导航栏错位了
>
> ↳ **bot** 复现了,是 header 那个 flex 容器没设 min-width。改完跑过构建,PR #128

> **@bot** 上周新增用户按渠道拆一下
>
> ↳ **bot** 一共 1842,自然量 1103、投放 604……(数据库密钥配过一次,之后它自己查)

> **@bot** 明早九点提醒我看这个构建结果
>
> ↳ **bot** 好。—— 第二天九点它自己回到这个话题

## 和「群里加个 AI」不一样的地方

- **每个群有一台自己的 Linux 机器** —— 能联网、读写文件、跑命令、`apt` 装软件、clone 仓库。
  装过的东西和攒下的文件长期留着,下次接着做;不是每轮从零开始的无状态容器。
- **一个问题一段独立上下文** —— 回答发进话题,同一话题内继续 @ 它有上下文;
  几个人同时问几件事也不会串在一起。
- **群与群互相看不见** —— 工作区、密钥、长期记忆都是一群一份。
- **接不接话它自己判断** —— 话题里没 @ 它的消息它也听得到,但沉默是默认,不会抢话。
- **第三方密钥你自己填** —— 群里说「配一下 Sentry 的 token」,它发一张密码卡片,
  值直达 bot 进程,不经过 AI、不进消息记录。
- **能自己排定时回访** —— 到点它主动回到那个话题找你,不用你记着。

私聊已禁用,@所有人 不响应。飞书自己的云文档、日历、建群这些目前做不了。

## 常见场景

**接上 GitHub 仓库** —— 密钥走密码卡片,值不经过 AI:

> **@bot** 配一下 GitHub token,仓库是 acme/webapp
>
> ↳ **bot** 发出密码卡片,填完它自己 clone;之后修 bug、跑测试、提 PR 都在这个仓库上

**接一台 Mac 构建 iOS 应用** —— 沙箱是 Linux 跑不了 Xcode,给它一台能 SSH 的 Mac:

> **@bot** 局域网 10.0.0.8 那台 Mac,用户名 ci,iOS 打包用它
>
> ↳ **bot** 在沙箱里生成了 SSH 密钥,把这段公钥加到那台 Mac 的 authorized_keys:`ssh-ed25519 AAAA…`
>
> 之后说「打个 TestFlight 包」,它就 ssh 过去跑 xcodebuild,结果带回话题

## 前置条件

- **一个能建自建应用的飞书账号** —— 要企业管理员,或者管理员给过「创建应用」权限;个人版飞书不行。
- **macOS 或 Linux** —— 沙箱靠 Incus,只有这两条路,Windows 上没有。
  mac 要有 [Homebrew](https://brew.sh);Linux 的自动安装覆盖 apt 系(Debian 13+ / Ubuntu 24.04+),
  其他发行版先自装 Node 与 Incus(装法脚本会打出来)。
- **一份模型令牌** —— Claude 订阅(`claude setup-token` 生成)或 Anthropic API key,二选一。

## 运行

```bash
curl -fsSL https://raw.githubusercontent.com/singtown/feishu-tag/main/install.sh | bash
```

交互式一路走完:装运行时 → 建飞书应用(手机飞书打开链接或扫码确认)→ 收模型令牌
(隐藏输入直接落盘)。凭证全程不经过 AI

收尾可设开机自启,崩了自动拉起(mac 是登录自启,无人值守需开自动登录)。之后:

- **Linux**:启停 `systemctl start|stop feishu-tag`,日志 `journalctl -u feishu-tag -f`
- **mac**:停 `launchctl bootout gui/$(id -u)/local.feishu-tag`(别用 `stop`,会被拉起),
  启 `launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/local.feishu-tag.plist`,
  日志 `~/Library/Logs/feishu-tag.log`

没设自启就 `npm start` 前台跑,得一直开着;服务在跑时别再手动 `npm start`,会双连重复收消息。

装完把机器人拉进群,@ 它说句话。mac 首次启动要建虚拟机,约几分钟;每个群第一次说话
要建自己的沙箱,约 1 分钟——静默等着不是坏了,之后每轮秒回。

## 为什么不用企业微信

- **分支回复没有 API**:话题(分支)是"一个问题一段独立上下文"的基础,企微发不出来。
- **读不到任意消息**:企微只给得到 @ 机器人的那一条,群里其他消息拿不到。

---

本项目由 [Claude Tag](https://www.claude.com/claude-in-slack) 启发。

MIT License
