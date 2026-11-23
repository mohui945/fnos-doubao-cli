#!/bin/bash
# 构建豆包 CLI 的飞牛 fpk 安装包
set -e
cd "$(dirname "$0")/.."

echo "[build] 应用：$(grep '^appname' manifest | awk '{print $3}')  版本：$(grep '^version' manifest | awk '{print $3}')"

if [ ! -x app/runtime/doubao ]; then
    echo "[build] 错误：app/runtime 下缺少豆包 CLI 运行时" >&2
    exit 1
fi
if [ ! -x app/server/ttyd ]; then
    echo "[build] 错误：app/server 下缺少 ttyd" >&2
    exit 1
fi

chmod 755 cmd/* app/bin/* app/server/ttyd app/runtime/doubao
chmod 644 app/ui/index.html app/ui/config app/server/server.js app/ui/images/*.png ICON.PNG ICON_256.PNG

fnpack build

ls -lh doubao.fpk
echo "[build] 完成：$(pwd)/doubao.fpk"
