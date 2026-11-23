#!/bin/bash
# 拉齐打包所需的外部依赖（官方运行时、ttyd、Pillow、fnos-cli 技能二进制）。
# 这些都不入库：体积大、且是第三方发布物，用本脚本按版本下载并校验。
# 用法：./scripts/fetch-deps.sh [--force]
set -euo pipefail
cd "$(dirname "$0")/.."

FORCE=0
[ "${1:-}" = "--force" ] && FORCE=1

RUNTIME_VER="${RUNTIME_VER:-2.37.2}"
TTYD_VER="${TTYD_VER:-1.7.7}"
PILLOW_VER="${PILLOW_VER:-13.0.0}"
FNOS_CLI_VER="${FNOS_CLI_VER:-0.6.2}"

# fnos-cli 0.6.2 的官方发布物校验值（脚本 scripts/fnos-cli 内嵌同一组值）
FNOS_CLI_GZ_SHA="f3233408662bf667355135771ce0d6db856ef334f16c5a552a53970976ffdc79"
FNOS_CLI_BIN_SHA="08e6cd9f3017ce55b6d864ab304aba9d054b6a2af9d421a648e4d13ac62b0572"

need() { command -v "$1" >/dev/null 2>&1 || { echo "[fetch] 缺少命令：$1" >&2; exit 1; }; }
need curl; need tar; need sha256sum

TMP=$(mktemp -d); trap 'rm -rf "$TMP"' EXIT

# 1) 豆包官方 CLI 运行时（linux-x64，自包含）
if [ -f app/runtime/doubao ] && [ "$FORCE" = 0 ]; then
    echo "[fetch] 运行时已存在，跳过下载：app/runtime"
else
    URL="https://lf-flow-web-cdn.doubao.com/obj/flow-doubao/doubao_cli/${RUNTIME_VER}/doubao-cli-${RUNTIME_VER}-linux-x64-signed.tar.gz"
    echo "[fetch] 下载运行时 ${RUNTIME_VER}（约 240 MB）"
    curl -fL --retry 3 -o "$TMP/runtime.tar.gz" "$URL"
    mkdir -p "$TMP/rt"
    tar -xzf "$TMP/runtime.tar.gz" -C "$TMP/rt"
    # 官方包顶层通常是一个版本目录，若只有一个子目录就展开它
    if [ "$(find "$TMP/rt" -mindepth 1 -maxdepth 1 -type d | wc -l)" = 1 ] && \
       [ ! -f "$TMP/rt/manifest.json" ]; then
        SRC="$(find "$TMP/rt" -mindepth 1 -maxdepth 1 -type d)"
    else
        SRC="$TMP/rt"
    fi
    [ -x "$SRC/doubao" ] || { echo "[fetch] 运行时包里找不到可执行的 doubao" >&2; exit 1; }
    rm -rf app/runtime
    mkdir -p app/runtime
    cp -a "$SRC"/. app/runtime/
    chmod 755 app/runtime/doubao
fi

# 2) ttyd：Web 终端与 PTY 代理
if [ -x app/server/ttyd ] && [ "$FORCE" = 0 ]; then
    echo "[fetch] ttyd 已存在，跳过下载"
else
    echo "[fetch] 下载 ttyd ${TTYD_VER}"
    curl -fL --retry 3 -o "$TMP/ttyd" "https://github.com/tsl0922/ttyd/releases/download/${TTYD_VER}/ttyd.x86_64"
    mkdir -p app/server
    install -m 755 "$TMP/ttyd" app/server/ttyd
    app/server/ttyd --version || true
fi

# 3) Pillow：扫码登录时把二维码 PNG 转成终端 ANSI 块（打包进 app/pylib）
if [ -d app/pylib/PIL ] && [ "$FORCE" = 0 ]; then
    echo "[fetch] app/pylib 已存在，跳过 Pillow"
else
    echo "[fetch] 安装 Pillow ${PILLOW_VER} 到 app/pylib"
    python3 -m pip install --quiet --no-cache-dir --no-deps \
        --only-binary=:all: --target app/pylib "pillow==${PILLOW_VER}" \
      || { echo "[fetch] Pillow 安装失败：检查 python3 -m pip 与网络（可用 --index-url 指定镜像）" >&2; exit 1; }
fi

# 4) fnos-cli 技能自带的命令行二进制（首次运行会联网下载，这里预置进包）
FNOS_BIN=app/skills/fnos-cli/bin/fnos-cli
if [ -x "$FNOS_BIN" ] && [ "$FORCE" = 0 ]; then
    echo "[fetch] fnos-cli 二进制已存在，跳过下载"
else
    echo "[fetch] 下载 fnos-cli ${FNOS_CLI_VER} linux-x64"
    curl -fL --retry 3 -o "$TMP/fnos-cli.gz" \
        "https://github.com/fnnas-labs/fnos-cli-skill/releases/download/v${FNOS_CLI_VER}/fnos-cli-${FNOS_CLI_VER}-linux-x64.gz"
    echo "${FNOS_CLI_GZ_SHA}  $TMP/fnos-cli.gz" | sha256sum -c - >/dev/null
    gzip -dc "$TMP/fnos-cli.gz" > "$TMP/fnos-cli"
    echo "${FNOS_CLI_BIN_SHA}  $TMP/fnos-cli" | sha256sum -c - >/dev/null
    mkdir -p app/skills/fnos-cli/bin
    install -m 755 "$TMP/fnos-cli" "$FNOS_BIN"
fi

# 5) 给运行时注入「权限档位强制」补丁（幂等）
python3 scripts/patch-runtime.py

echo "[fetch] 依赖就绪。下一步：./scripts/build.sh"
