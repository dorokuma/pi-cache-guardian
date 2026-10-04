#!/usr/bin/env bash
# install.sh — 把仓库版 cache-guardian 扩展同步安装到 ~/.pi/agent/extensions/。
#
# 背景：AGENTS.md「生效位置」与 README.md「Direct copy」此前只有手工 cp（旧副本
# 先备份成 .bak-<时间戳> 再覆盖），没有任何机制保证同步被执行——部署目录里的
# cache-guardian.ts.bak-2026* 就是这套手工流程的残留。本脚本把该步骤收成一个
# 可单独执行验证的入口：
#   integrations/pi/install.sh      # 或 pnpm sync
#
# DEST 语义定稿：目标是一个「文件路径」（~/.pi/agent/extensions/
# cache-guardian.ts），不接受目录——指向已存在目录时显式失败，不静默补全
# 文件名、不静默拷进目录。PI_EXT_DEST 可覆盖（验证/多机部署场景），且优先于
# HOME：显式指定时不再校验 HOME（详见下方 PI_EXT_DEST 优先定稿）。
#
# 幂等：目标 md5 与源一致时报告未变化且不重写（不动 mtime）。
# 失败语义：所有校验/IO 失败都必须有可见输出（stderr）并非零退出——
# 静默失败正是本次要消灭的漂移形态（样板仓实测：PATH 无 md5sum 时旧脚本
# 静默 exit 127、stdout/stderr 全空；md5 取空时带着空值走进 unchanged 分支
# 静默跳过同步）。契约与 codegraph-go 仓 integrations/pi/install.sh 对齐，
# 双审 must-fix 与决策见 .agents/notes/20261004-pi-ext-sync-install-script.md。
set -euo pipefail

fail() { echo "install.sh FAILED: $*" >&2; exit 1; }

# md5sum 缺失必须显式失败：曾经的 2>/dev/null 把「command not found」也吞了，
# 表现为零输出 + exit 127，同步失败却无任何信号。
command -v md5sum >/dev/null 2>&1 || fail "md5sum not found in PATH (PATH=$PATH)"

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
SRC="$ROOT/extensions/cache-guardian.ts"

# PI_EXT_DEST 优先于 HOME：显式指定 PI_EXT_DEST 时直接采用、不再校验
# HOME；仅在未指定时才回落到 HOME。否则「set PI_EXT_DEST explicitly」的
# 报错文案与「HOME 未设置即失败」的行为自相矛盾（双审实测：
# env -u HOME PI_EXT_DEST=/tmp/x.ts 被 HOME 拦下、FAILED exit 1）。
if [ -n "${PI_EXT_DEST:-}" ]; then
  DEST="$PI_EXT_DEST"
else
  # HOME 未导出时 set -u 只会抛一句晦涩的「未绑定的变量」；显式给出可操作提示。
  HOME_DIR="${HOME:-}"
  [ -n "$HOME_DIR" ] || fail "HOME is not set (or empty) — export HOME or set PI_EXT_DEST explicitly"
  DEST="$HOME_DIR/.pi/agent/extensions/cache-guardian.ts"
fi
[ -n "$DEST" ] || fail "destination is empty"
case "$DEST" in
  /*) ;;
  *) fail "destination is not an absolute path: $DEST" ;;
esac
if [ -d "$DEST" ]; then
  fail "destination is a directory: $DEST — expected the extension file path (须指定文件名而非目录本体)"
fi

[ -f "$SRC" ] || fail "source not found: $SRC"

md5_of() {
  local line
  # 不吞 stderr、不吞退出码：md5sum 本身的失败（如文件不可读）也要显性化。
  if ! line="$(md5sum "$1")"; then
    fail "md5sum failed for: $1"
  fi
  printf '%s' "${line%% *}"
}

SRC_MD5="$(md5_of "$SRC")"
[ -n "$SRC_MD5" ] || fail "source md5 is empty: $SRC"
if [ -f "$DEST" ]; then
  DEST_MD5="$(md5_of "$DEST")"
  [ -n "$DEST_MD5" ] || fail "target md5 is empty: $DEST"
else
  DEST_MD5="(none)"
fi

echo "pi extension sync"
echo "  source:      $SRC"
echo "  source md5:  $SRC_MD5"
echo "  destination: $DEST"
echo "  target md5:  $DEST_MD5"

if [ -f "$DEST" ] && [ "$DEST_MD5" = "$SRC_MD5" ]; then
  echo "unchanged: destination already matches source (md5 $SRC_MD5), nothing written"
else
  # 目标父目录在新机器上可能不存在（~/.pi/agent/extensions），先建好。
  mkdir -p "$(dirname "$DEST")"
  install -m 644 "$SRC" "$DEST"
  echo "changed: installed $DEST (md5 $SRC_MD5)"
fi

echo "note: Pi 只在会话启动时加载扩展——需 /reload 或新会话才生效"
