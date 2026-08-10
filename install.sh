#!/usr/bin/env bash
# feishu-tag 一键安装/升级器,README 的唯一部署入口:
#   curl -fsSL .../install.sh | bash   —— 自举:自动 clone 到 ~/feishu-tag 再换乘仓库里那份
#   ./install.sh                       —— 已 clone 的仓库里直接跑,同一个文件同一条路
# 重跑即升级:maybe_update 发现落后上游就问一声、快进、重跑自己,自启段照着
# FEISHU_TAG_UPDATED 用新代码重启服务。
# 管道形态只负责 clone,然后把 stdin 换成 /dev/tty 交给文件形态;真无头(没有终端)才拒绝。
#
# 分工(2026-08-08 拍板):sh 只做「Node 存在之前」的事——
# 装 node + incus、加组、收模型令牌直写 .env;唯一需要 SDK 的建应用一步交给
# `npm run register`(register.ts 自己写 .env);收尾的开机自启(systemd)
# 也归 sh。凭证不跨语言边界:令牌 read -s 收下后
# 本进程直写 .env,不进 argv、不进 ps、不回显;飞书凭证在 TS 进程内闭环。
#
# 踩坑清单,改之前看一眼:
# - 这是 bash 不是 POSIX sh(read -s / trap / local)。typecheck 罩不到本文件:
#   改完先 `bash -n install.sh`,再真机跑。它也是全仓库最容易
#   随发行版世界漂移的文件,动 apt/NodeSource 那段必须 Debian/Ubuntu 真机验证。
# - Linux 只支持 apt 系(Debian 13+ / Ubuntu 24.04+,incus 已进发行版仓库);其他发行版
#   打印装法指引后退出。别试图写死各家装法——没法验证的分叉必腐烂,指引腐烂是软失败。
# - NodeSource 用手动加 keyring + 源的方式,故意不跑他家 setup 脚本:curl | sudo bash
#   跑第三方脚本不符合本仓库的执行边界口径。
# - usermod 加组后不用重新登录:sg 按 /etc/group 现查成员资格,直接以新组身份 exec 自己
#   续跑(FEISHU_TAG_SG 防死循环:sg 没生效就明说要重登)。重登留给用户下次自然发生,
#   新登录和 systemd 服务天然带上组。
# - 写 .env 用「过滤旧键再追加」,不用 sed 替换——令牌里出现 & 之类字符时 sed 的替换串
#   会展开出错,过滤重写没有转义问题。register.ts 的 envSet 是同款的 TS 版,改要一起改。
# - subuid/subgid 修补是**条件式**的:已有 root: 条目才补当前 uid/gid,没有条目是
#   incus 全权模式,无条件追加会把好机器改坏(详见 Linux 分支就地注释)。
# - Docker 共存分两半:sudoers 白名单归这儿,插 DOCKER-USER 规则归 sandbox.ts 的
#   ensureDockerCoexist;四条命令 sudoers 逐字匹配,两边必须一字不差。
# - 本文件只管「装没装」;查存储池等运行态检查归 sandbox.ts 的 ensureHostReady
#   (npm start 时自动跑),别搬过来。
# - 开机自启:node/npm/仓库路径在安装时写死,重跑按内容比对重写。

set -eu
umask 077   # 本脚本创建的文件(.env / .env.bak)天生 600

# 失败时补一句救援提示;用户主动 Ctrl-C 不算失败,INT 里先关掉再退,免得误报
RESCUE_ON=1
on_exit() {
  code=$?
  if [ "$code" -ne 0 ] && [ "$RESCUE_ON" = 1 ]; then
    printf '\n卡住了的话,把上面的报错交给 Claude Code:\n  claude "帮我修 feishu-tag 安装:<报错>"\n'
  fi
}
trap on_exit EXIT
trap 'RESCUE_ON=0; printf "\n已中断。重跑 ./install.sh,做过的步骤会自动跳过。\n"; exit 130' INT

say() { printf '\n▸ %s\n' "$1"; }
die() { printf '\n✗ %s\n' "$1" >&2; exit 1; }

confirm() {  # 空回车 = 是:重跑是常态,一路回车必须依旧安全
  local a
  # EOF 必须当场死:tty 里输入流也可能断(Ctrl-D、pty 被关),read 失败还往下走
  # 就成了「全部自动应答是」,能把服务都静默拉起来(实测踩过)
  read -r -p "$1 [Y/n] " a || die '输入中断,重跑 ./install.sh 继续'
  case "$a" in ''|y|Y|yes|Yes|YES) return 0 ;; *) return 1 ;; esac
}

node_ok() {
  command -v node >/dev/null 2>&1 || return 1
  node -e 'var v=process.versions.node.split(".");process.exit(+v[0]>22||(+v[0]===22&&+v[1]>=18)?0:1)'
}

env_has() { [ -f .env ] && grep -q "^$1=" .env; }
env_set() {
  local key=$1 value=$2
  [ -f .env ] || : > .env
  grep -v "^${key}=" .env > .env.tmp || true
  printf '%s=%s\n' "$key" "$value" >> .env.tmp
  mv .env.tmp .env
  chmod 600 .env
}

in_repo() { [ -f package.json ] && grep -q '"name": "feishu-tag"' package.json; }

# 找到仓库根并 cd 进去,身边没有就 clone 到 ~/feishu-tag。已 clone 过就直接用现有的,
# 这里不 pull:拉新版归 maybe_update,确认制、不悄悄动本地。
# FEISHU_TAG_REPO 是测试缝隙(指到 file:// 本地镜像),平时不用碰
ensure_repo() {
  in_repo && return 0
  local dest="$HOME/feishu-tag"
  say "获取仓库到 $dest"
  command -v git >/dev/null 2>&1 || die '缺 git:sudo apt-get install -y git,装完重跑'
  if [ -d "$dest/.git" ]; then
    echo '已经 clone 过了,直接用现有的(有新版本的话稍后会问要不要升级)。'
  elif [ -e "$dest" ]; then
    die "$dest 已存在但不是这个仓库,挪开它再跑"
  else
    git clone "${FEISHU_TAG_REPO:-https://github.com/singtown/feishu-tag.git}" "$dest"
  fi
  cd "$dest"
}

# 管道形态(curl | bash,BASH_SOURCE 为空):脚本本体正从 stdin 流进来,fd0 一个字节都
# 不能动——bash 还要从这儿读后面的行,exec</dev/tty 或 read 都会把脚本自己吃掉(踩过)。
# 所以这个形态只做一件事:确认有终端、找到/克隆仓库,然后把 stdin 换成 /dev/tty
# exec 文件形态的自己,所有交互都发生在那边
if [ -z "${BASH_SOURCE[0]:-}" ]; then
  ( : < /dev/tty ) 2>/dev/null || { RESCUE_ON=0; die '要在交互式终端里跑:要扫码确认应用,还要粘贴令牌。'; }
  ensure_repo
  exec bash ./install.sh < /dev/tty
fi

cd "$(dirname "$0")"
if ! in_repo; then
  # 文件形态但身边不是仓库 = 脚本被单独拷走跑:clone 完换乘仓库里那份,别继续跑手里这份旧的
  ensure_repo
  exec bash ./install.sh
fi
SCRIPT="$PWD/install.sh"

echo 'feishu-tag 安装'
echo '每一步都会先看你是不是已经做过了,随时可以中断、重跑。'

# 非交互式下 read 拿到 EOF,confirm 会一路当「是」把 bot 起了,宁可当场停
[ -t 0 ] || { RESCUE_ON=0; die '要在交互式终端里跑:要扫码确认应用,还要粘贴令牌。'; }

# ---- 升级:重跑本脚本即升级,这一步只负责把代码带到最新 ----
# 落后上游且本地干净时,确认后快进并重跑自己;其余步骤本来就幂等,重跑一遍即完成升级。
# FEISHU_TAG_UPDATED 只表示「本轮是升级后的重跑」:自启段看到它才知道该重启服务换代码
# (须经 sg/exec 存活,所以走环境变量,和 FEISHU_TAG_SG 同款)。
# package-lock.json 会被不同版本的 npm 重写(libc 字段之类),只有它脏就直接还原;
# 其他任何本地改动都不碰,宁可不升级——和 ensure_repo 不 pull 是同一条底线
maybe_update() {
  [ -n "${FEISHU_TAG_UPDATED:-}" ] && { echo '刚升到最新,继续走完其余步骤。'; return 0; }
  git rev-parse --abbrev-ref '@{u}' >/dev/null 2>&1 || return 0  # 没上游的本地实验仓,不管
  git fetch --quiet 2>/dev/null || { echo '(联不上上游,跳过检查更新)'; return 0; }
  local behind ahead dirty
  behind="$(git rev-list --count 'HEAD..@{u}')"
  [ "$behind" = 0 ] && { echo '已是最新。'; return 0; }
  ahead="$(git rev-list --count '@{u}..HEAD')"
  if [ "$ahead" != 0 ]; then
    echo "上游有新版本,但本地多 $ahead 个自己的提交(分叉了),不自动升级。"
    return 0
  fi
  dirty="$(git status --porcelain | grep -v '^??' || true)"
  if [ -n "$dirty" ] && ! printf '%s\n' "$dirty" | grep -qv 'package-lock\.json'; then
    git checkout -- package-lock.json   # npm 重写的,不算用户改动
    dirty=''
  fi
  if [ -n "$dirty" ]; then
    printf '上游有新版本(落后 %s 个提交),但本地有改动,不自动升级:\n%s\n' "$behind" "$dirty"
    echo '处理完(commit / stash / checkout)重跑 ./install.sh 即可升级。'
    return 0
  fi
  confirm "上游有新版本(落后 $behind 个提交),现在升级?" || return 0
  git merge --ff-only '@{u}' || die '快进失败:git status 看看,处理完重跑'
  exec env FEISHU_TAG_UPDATED=1 bash "$SCRIPT"
}
say '检查更新'
maybe_update

SUDO=sudo
[ "$(id -u)" = 0 ] && SUDO=''

case "$(uname -s)" in
Linux)
  say '检查 Node 与沙箱运行时(apt)'
  command -v apt-get >/dev/null 2>&1 || die '自动安装目前只覆盖 apt 系(Debian 13+ / Ubuntu 24.04+)。
其他发行版:自己装好 node ≥22.18(nvm 或 nodejs.org)和 incus
(https://linuxcontainers.org/incus/docs/main/installing/ ,装完 usermod -aG incus-admin 加组、
重新登录、跑一次 incus admin init --minimal),然后重跑本脚本。'
  if ! node_ok || ! command -v incus >/dev/null 2>&1; then
    $SUDO apt-get update
  fi
  if ! node_ok; then
    $SUDO apt-get install -y curl ca-certificates
    $SUDO install -d -m 0755 /etc/apt/keyrings
    curl -fsSL https://deb.nodesource.com/gpgkey/nodesource-repo.gpg.key | $SUDO tee /etc/apt/keyrings/nodesource.asc >/dev/null
    echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/nodesource.asc] https://deb.nodesource.com/node_22.x nodistro main" \
      | $SUDO tee /etc/apt/sources.list.d/nodesource.list >/dev/null
    $SUDO apt-get update
    $SUDO apt-get install -y nodejs
    node_ok || die '装完 Node 还是不达标(要 ≥22.18),看看上面 apt 的报错'
  fi
  command -v incus >/dev/null 2>&1 || $SUDO apt-get install -y incus \
    || die 'apt 里没有 incus(Debian 12 及更早要走 backports):https://linuxcontainers.org/incus/docs/main/installing/'
  if [ -n "$SUDO" ] && ! id -nG | grep -qw incus-admin; then
    say "把 $USER 加进 incus-admin 组"
    $SUDO usermod -aG incus-admin "$USER"
    [ -n "${FEISHU_TAG_SG:-}" ] && die '加组没生效,重新登录一次再跑 ./install.sh(之后不会再有这一步)'
    echo '不用重新登录,以新组身份继续……'
    exec sg incus-admin -c "FEISHU_TAG_SG=1 exec $(printf '%q' "$SCRIPT")"
  fi
  if ! incus query /1.0 >/dev/null 2>&1; then
    $SUDO systemctl enable --now incus >/dev/null 2>&1 || true
    incus query /1.0 >/dev/null 2>&1 || die 'incus 服务端不可达:systemctl status incus 看看'
  fi
  if [ "$(incus query /1.0/storage-pools)" = '[]' ]; then
    say '初始化 incus(建默认存储池和网络)'
    incus admin init --minimal
  fi
  # Incus 只在 /etc/subuid 已有 root: 条目时进入受限模式:raw.idmap 要映的宿主 uid/gid
  # 必须被某个 root 段覆盖,否则沙箱 start 直接死(newuidmap … not allowed)。
  # 完全没有 root: 条目 = 全权模式,什么都不用做——**别改成无条件追加**,
  # 那会把全权模式切成受限模式,反而弄坏没这毛病的机器
  ensure_subid() {
    local file="/etc/$1" id_num="$2"
    grep -q '^root:' "$file" 2>/dev/null || return 0
    awk -F: -v n="$id_num" '$1=="root" && n>=$2 && n<$2+$3 {ok=1} END {exit ok?0:1}' "$file" && return 0
    say "$file 的 root 段不含 $id_num,补一条(沙箱 idmap 需要)"
    printf 'root:%s:1\n' "$id_num" | $SUDO tee -a "$file" >/dev/null
    SUBID_CHANGED=1
  }
  SUBID_CHANGED=0
  ensure_subid subuid "$(id -u)"
  ensure_subid subgid "$(id -g)"
  if [ "$SUBID_CHANGED" = 1 ]; then
    $SUDO systemctl restart incus   # incusd 只在启动时读 subuid
  fi
  # Docker 共存:Docker 会把 FORWARD 默认策略改成 DROP,闷死沙箱的 IPv4 转发。
  # 插放行规则的活在运行时(sandbox.ts 的 ensureDockerCoexist,规则重启就丢,得每次断言),
  # 这里只发 sudo 白名单:四条**逐字匹配**的命令,iptables 路径和参数跟那边是一对,改要同步。
  # docker 常常事后才装,所以无条件写;没 docker 时这四条命令无链可插,纯惰性授权
  SUDOERS_PATH=/etc/sudoers.d/feishu-tag
  if [ ! -e "$SUDOERS_PATH" ]; then
    BRIDGE="$(incus network list -f csv | awk -F, '$2=="bridge" && $3=="YES" {print $1; exit}')"
    if [ -n "$BRIDGE" ]; then
      say "写 $SUDOERS_PATH(允许 bot 往 DOCKER-USER 链补 $BRIDGE 的放行,仅这四条命令)"
      printf '%s ALL=(root) NOPASSWD: %s, %s, %s, %s\n' "$(id -un)" \
        "/usr/sbin/iptables -C DOCKER-USER -i $BRIDGE -j ACCEPT" \
        "/usr/sbin/iptables -I DOCKER-USER -i $BRIDGE -j ACCEPT" \
        "/usr/sbin/iptables -C DOCKER-USER -o $BRIDGE -j ACCEPT" \
        "/usr/sbin/iptables -I DOCKER-USER -o $BRIDGE -j ACCEPT" > sudoers.tmp
      $SUDO visudo -c -q -f sudoers.tmp || { rm -f sudoers.tmp; die "生成的 sudoers 没过 visudo 校验(桥名 $BRIDGE 有怪字符?)"; }
      $SUDO install -m 440 -o root -g root sudoers.tmp "$SUDOERS_PATH"
      rm -f sudoers.tmp
    fi
  fi
  ;;
*)
  die "不支持的平台 $(uname -s):沙箱靠 Incus,只支持 Linux"
  ;;
esac
echo '运行时就绪。'

say '装依赖'
npm install || die 'npm install 失败。'

say '飞书应用'
app_id="$(sed -n 's/^FEISHU_BOT_ID=//p' .env 2>/dev/null || true)"
if [ -n "$app_id" ] && confirm ".env 里已有应用 $app_id,继续用它?(选 n 重新创建)"; then
  echo '沿用现有应用。'
else
  if [ -n "$app_id" ]; then
    cp .env .env.bak && chmod 600 .env.bak
    echo '当前 .env 已备份到 .env.bak。旧应用不会被删,不用了自己去开放平台下架。'
  fi
  echo '下面会打印一个链接,用飞书 App 打开确认即可。权限、事件、回调、长连接一次配齐。'
  echo '凭证直接写进 .env,不打印、不进对话。'
  npm run register || die '建应用失败。最常见的原因是这个账号没有创建自建应用的权限(要企业管理员,或管理员授权)。'
fi

if env_has ANTHROPIC_API_KEY || env_has CLAUDE_CODE_OAUTH_TOKEN; then
  say '模型令牌已经在 .env 里了,跳过'
else
  say '配模型令牌'
  echo 'agent 跑在沙箱里,用不了你宿主上 Claude 的登录态,得单独给一份。'
  # 前缀不拿来替用户定字段,只做矛盾报警:订阅令牌 sk-ant-oat 开头、API key 是 sk-ant-api
  if confirm '有 Claude 订阅吗?(选 n 走 Anthropic API key)'; then kind=oauth; else kind=api; fi
  if [ "$kind" = oauth ]; then
    echo '另开一个终端跑 claude setup-token,把打印出来的令牌贴到下面。'
  else
    echo '去 https://console.anthropic.com/settings/keys 拿一个 key,贴到下面。'
  fi
  read -r -s -p '令牌(粘贴后回车,不会显示):' token
  echo
  [ -n "$token" ] || die '没拿到令牌。弄到之后重跑 ./install.sh,前面几步会自动跳过。'
  case "$token" in
  sk-ant-oat*) looks=oauth ;;
  sk-ant-api*) looks=api ;;
  *) looks="$kind" ;;
  esac
  if [ "$looks" != "$kind" ]; then
    if [ "$looks" = oauth ]; then
      echo '这个令牌 sk-ant-oat 开头,是 claude setup-token 生成的订阅令牌,不是 API key。'
    else
      echo '这个令牌 sk-ant-api 开头,是 Anthropic API key,不是订阅令牌。'
    fi
    confirm '按它实际的类型写入?' || die '确认好令牌类型再重跑,前面几步会自动跳过。'
    kind=$looks
  fi
  if [ "$kind" = oauth ]; then env_set CLAUDE_CODE_OAUTH_TOKEN "$token"; else env_set ANTHROPIC_API_KEY "$token"; fi
  echo '已写进 .env(权限收到 600)。'
fi

say '装完了'
echo '把机器人拉进飞书群,@ 它说句话。'
echo '第一次会静默等约 1 分钟——那个群的专属沙箱正在建,不是坏了;之后每轮秒回。'

# ---- 开机自启:systemd unit ----
# 服务上下文默认 PATH 很瘦,必须显式给

UNIT_PATH=/etc/systemd/system/feishu-tag.service

unit_content() {
  cat <<EOF
[Unit]
Description=feishu-tag
After=network-online.target incus.service
Wants=network-online.target

[Service]
User=$(id -un)
WorkingDirectory=$PWD
Environment=PATH=$(dirname "$(command -v node)"):/usr/local/bin:/usr/bin:/bin
ExecStart=$(command -v npm) start
Restart=on-failure
RestartSec=10

[Install]
WantedBy=multi-user.target
EOF
}

same_file() { [ -f "$2" ] && printf '%s\n' "$1" | cmp -s - "$2"; }

start_foreground() {
  if confirm '现在就前台启动吗?'; then
    # exec 交接出去:后面的退出码、Ctrl-C 都是 npm start 的事,EXIT trap 也随之失效,不会误报救援
    exec npm start
  fi
}

autostart_linux() {
  if [ ! -d /run/systemd/system ]; then
    echo '没检测到 systemd(容器/老 WSL?),跳过开机自启,日常手动 npm start。'
    start_foreground; return 0
  fi
  local content; content="$(unit_content)"
  if same_file "$content" "$UNIT_PATH" && systemctl is-enabled --quiet feishu-tag 2>/dev/null; then
    if [ -n "${FEISHU_TAG_UPDATED:-}" ]; then
      echo '重启服务,加载新代码……'
      $SUDO systemctl restart feishu-tag
      sleep 2
      systemctl is-active --quiet feishu-tag || die '服务没起来:journalctl -u feishu-tag -e 看看'
      echo '升级完成,服务已在新代码上运行。'
    else
      echo '开机自启已配置(没在跑就 systemctl start feishu-tag)。'
    fi
    return 0
  fi
  if ! confirm '设为开机自启并现在启动?(选 n 走前台 npm start)'; then
    start_foreground; return 0
  fi
  printf '%s\n' "$content" | $SUDO tee "$UNIT_PATH" >/dev/null
  $SUDO chmod 644 "$UNIT_PATH"
  $SUDO systemctl daemon-reload
  $SUDO systemctl enable feishu-tag
  $SUDO systemctl restart feishu-tag
  sleep 2
  systemctl is-active --quiet feishu-tag || die '服务没起来:journalctl -u feishu-tag -e 看看,修好后重跑 ./install.sh'
  echo '已启动,开机自启。别再手动 npm start,会双连重复收消息。'
  echo '  日志 journalctl -u feishu-tag -f;启停 systemctl start|stop feishu-tag'
}

say '开机自启'
echo '飞书长连接得一直开着;设成系统服务,开机自启、崩了自动拉起。'
autostart_linux
