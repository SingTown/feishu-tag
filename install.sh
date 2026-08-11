#!/usr/bin/env bash
# feishu-tag 一键安装/升级器:README 的 curl | bash 和 ./install.sh 是同一个文件,重跑即升级。
# 只负责装软件和开机自启,配置(建应用、模型令牌)由用户自己做;跑起来之后的检查归 sandbox.ts 的 ensureHostReady。
# 保持全程零交互。
# 这是 bash 不是 POSIX sh;apt/NodeSource 段改动要 Debian/Ubuntu 真机验证。

set -eu

die() { printf '\n✗ %s\n' "$1" >&2; exit 1; }

[ "$(uname -s)" = Linux ] || die "不支持平台 $(uname -s): 只支持 Linux"

# 沙箱数据目录靠 disk device 的 shift(恒等映射)对齐属主:跑 bot 的必须是
# uid/gid 都为 1000 的普通用户(= 沙箱内 agent,见 src/sandbox.ts),root 也不行
[ "$(id -u)" = 1000 ] && [ "$(id -g)" = 1000 ] \
  || die "必须用系统第一个用户运行(uid/gid 为1000): (当前 $(id -u):$(id -g))"

# git 得在 clone 之前就位
sudo apt-get update
sudo apt-get install -y git incus

# ---- 装 Node(NodeSource):没有才装;已有的不动,版本不达标就退出 ----
# 手动加 keyring + 源,故意不跑 NodeSource 的 setup 脚本:不给第三方脚本 root 执行面
if ! command -v node >/dev/null 2>&1; then
  sudo apt-get install -y curl ca-certificates
  sudo install -d -m 0755 /etc/apt/keyrings
  curl -fsSL https://deb.nodesource.com/gpgkey/nodesource-repo.gpg.key | sudo tee /etc/apt/keyrings/nodesource.asc >/dev/null
  echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/nodesource.asc] https://deb.nodesource.com/node_22.x nodistro main" \
    | sudo tee /etc/apt/sources.list.d/nodesource.list >/dev/null
  # keyring 由 _apt 用户(sqv)读,600 会拒签;不赌调用方 shell 的 umask,显式放开
  sudo chmod 644 /etc/apt/keyrings/nodesource.asc /etc/apt/sources.list.d/nodesource.list
  sudo apt-get update
  sudo apt-get install -y nodejs
fi
node -e 'var v=process.versions.node.split(".");process.exit(+v[0]>22||(+v[0]===22&&+v[1]>=18)?0:1)' \
  || die "Node 版本太低(需要 ≥22.18,当前 $(node -v))，请完全卸载后重试"

# ---- 配置沙箱运行时(incus) ----
# 装机操作全走 sudo,不依赖当前会话的组身份;加组是给日后的 systemd 服务和新登录用的
sudo usermod -aG incus-admin "$USER"
sudo systemctl enable --now incus
# 空列表在 incus 6.0 上打印空串而不是 [](实测),两种都算"还没初始化"
case "$(sudo incus query /1.0/storage-pools)" in
''|'[]')
  sudo incus admin init --minimal
  ;;
esac
# 预拉沙箱出厂镜像,把首个群要等的下载挪到装机时;
# 和 src/sandbox.ts 的 BASE_IMAGE 是同一个镜像,改要一起改
sudo incus image copy images:debian/13 local: --auto-update

# ---- clone 仓库:不存在才 clone,进到 ~/feishu-tag ----
# FEISHU_TAG_REPO 是测试缝隙(指到 file:// 本地镜像),平时不用碰
[ -d "$HOME/feishu-tag" ] || git clone "${FEISHU_TAG_REPO:-https://github.com/singtown/feishu-tag.git}" "$HOME/feishu-tag"
cd "$HOME/feishu-tag"

# ---- 更新仓库到最新:先停服务再动代码,收尾自启段会用新代码重新拉起 ----
# pull 失败(没网、分叉)由 set -e 当场停;升级若改了 install.sh 自身,
# 新逻辑下次重跑才生效(正在跑的 bash 握着旧文件)
if systemctl is-active --quiet feishu-tag 2>/dev/null; then
  sudo systemctl stop feishu-tag
fi
git pull --ff-only

# 只检查 .env 里有没有这一项,不读它的值(凭证规矩见 CLAUDE.md)
env_has() { [ -f .env ] && grep -q "^$1=" .env; }

# ci 不是 install:严格按 package-lock 装、从不写回它——lockfile 永不变脏,上面的 git pull 才裸得起来
npm ci

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

unit="$(unit_content)"
if ! same_file "$unit" "$UNIT_PATH"; then
  printf '%s\n' "$unit" | sudo tee "$UNIT_PATH" >/dev/null
  sudo chmod 644 "$UNIT_PATH"
  sudo systemctl daemon-reload
fi
sudo systemctl enable feishu-tag
# 查哪几项是照抄 index.ts 的启动检查,改要一起改;缺着就启动,服务只会反复崩溃重启
if env_has FEISHU_BOT_ID && env_has FEISHU_BOT_SECRET \
  && { env_has ANTHROPIC_API_KEY || env_has CLAUDE_CODE_OAUTH_TOKEN; }; then
  # 脚本开头更新代码前可能刚把服务停了,所以不管现在跑没跑,一律 restart 拉起
  sudo systemctl restart feishu-tag
  sleep 2
  systemctl is-active --quiet feishu-tag || die '服务运行失败: 请检查journalctl -u feishu-tag -e'
  echo '已开机自启。日志 journalctl -u feishu-tag -f;启停 systemctl start|stop feishu-tag'
else
  # 上回装完没配置就重启过机器的话,服务可能正在反复崩溃重启,先停下来等配置
  sudo systemctl stop feishu-tag
  echo '安装成功！在 ~/feishu-tag 目录配置:'
  echo '  1. npm run register    # 用飞书扫码创建应用,凭证会自动写进 .env'
  echo '  2. 把模型令牌写进 .env'
  echo '  3. sudo systemctl start feishu-tag # 开机运行'
fi
