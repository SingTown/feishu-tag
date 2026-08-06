#!/bin/sh
# 群沙箱的出厂初始化,在沙箱内部以 root 跑一次(见 src/sandbox.ts)。
# 用法: provision.sh <claudeCodeVersion>
#
# 幂等:每一步都是"没有才装",脚本改了哈希会变,bot 会对老沙箱重跑一遍
# (对应旧 macOS 账号方案里的 provision.hash)。
# 沙箱不是一次性的:这里装的东西就长在它的文件系统里,不会因为升级而消失——
# agent 后来自己 apt 装的包也一样,所以别把这个脚本当成"环境的唯一真相"去做清理。
set -eu

CLI_VERSION="${1:?用法: provision.sh <claudeCodeVersion>}"
export DEBIAN_FRONTEND=noninteractive

# 只装基础工具。构建工具链(build-essential/python3)故意不预装:
# agent 有免密 sudo,缺什么自己 apt 装,而且装完就一直在
if ! command -v git >/dev/null 2>&1; then
  apt-get update -qq
  apt-get install -y -qq --no-install-recommends \
    ca-certificates curl git jq less procps ripgrep sudo tzdata unzip xz-utils
fi

# CLI 版本由 bot 侧的 SDK 决定。这里是唯一的升级入口:沙箱不会被重建,
# 所以换版本只能靠原地重装(bot 每次都会比对指纹,见 sandbox.ts 的 STAMP)。
# CLI 是自带运行时的原生二进制,这儿直接取官方产物,沙箱里因此不需要 node。
# 不走官方 install.sh:它装进 $HOME/.local/bin(不在 incus exec 给的 PATH 上)、
# 拿挂载进来的 ~/.claude 当下载暂存、还会配上自更新——自更新会在指纹没变的情况下把版本挪走
if [ "$(claude --version 2>/dev/null | awk '{print $1}')" != "$CLI_VERSION" ]; then
  case "$(dpkg --print-architecture)" in
    arm64) PLATFORM=linux-arm64 ;;
    amd64) PLATFORM=linux-x64 ;;
    *) echo "不支持的架构: $(dpkg --print-architecture)" >&2; exit 1 ;;
  esac
  BASE="https://downloads.claude.ai/claude-code-releases/${CLI_VERSION}"
  SUM=$(curl -fsSL "${BASE}/manifest.json" | jq -re ".platforms[\"${PLATFORM}\"].checksum")
  # 先下到同目录再 rename:直接覆盖正在跑的 claude 会 ETXTBSY(别的话题可能开着会话)
  curl -fsSL -o /usr/local/bin/claude.new "${BASE}/${PLATFORM}/claude"
  echo "${SUM}  /usr/local/bin/claude.new" | sha256sum -c - >/dev/null
  chmod 755 /usr/local/bin/claude.new
  mv -f /usr/local/bin/claude.new /usr/local/bin/claude
fi

# agent 用户:uid 1000 和 exec 时传的 --user 对上。有免密 sudo——
# 沙箱内的 root 不是宿主的 root,给它省得每次装包都来找人
if ! id -u agent >/dev/null 2>&1; then
  useradd -m -u 1000 -s /bin/bash agent
fi
echo 'agent ALL=(ALL) NOPASSWD: ALL' > /etc/sudoers.d/agent
chmod 440 /etc/sudoers.d/agent

# /home/agent/.claude 是宿主 sandbox/<id>/claude 挂进来的(见 src/sandbox.ts)。
# 挂载点先于 useradd 存在,useradd -m 就不补 skel、也不 chown home,这里补上。
# **别 chown -R /home/agent**:.claude 那半的属主归宿主平台管(mac 走不做 uid 映射的 virtiofs,
# 显示成 root/nobody 但 agent 照样读写;Linux 由 raw.idmap 映好),沙箱内没有一个 chown 是对的
# ——mac 上白报错,Linux 上会连宿主那边的文件属主一起改。只动家目录本身那几个
cp -rn /etc/skel/. /home/agent/ 2>/dev/null || true
chown agent:agent /home/agent
chown agent:agent /home/agent/.bashrc /home/agent/.profile /home/agent/.bash_logout 2>/dev/null || true

# CLI 的用户配置是两处:~/.claude/ 目录之外还有 ~/.claude.json(user scope 的 MCP 配置等)。
# 软链进挂载目录,沙箱重建后这半边配置才不会跟着没。
# 老沙箱里它是真文件,先搬进去再换软链,别直接覆盖
if [ -f /home/agent/.claude.json ] && [ ! -L /home/agent/.claude.json ]; then
  mv -n /home/agent/.claude.json /home/agent/.claude/.claude.json 2>/dev/null || true
  rm -f /home/agent/.claude.json
fi
ln -sfn /home/agent/.claude/.claude.json /home/agent/.claude.json

# 工作区归 agent
install -d -m 755 -o agent -g agent /home/agent/workspace

echo "provisioned $(claude --version 2>/dev/null | head -1)"
