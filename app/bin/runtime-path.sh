#!/bin/bash
# 解析当前生效的豆包 CLI 运行时目录。
# 被 term / login 通过 source 复用：优先已升级的 runtime/current，否则用内置 runtime。

doubao_runtime_dir() {
    local var_root dest
    var_root="${TRIM_PKGVAR:-/var/apps/doubao/var}/runtime"
    dest="${TRIM_APPDEST:-/var/apps/doubao/target}"
    if [ -x "${var_root}/current/doubao" ]; then
        printf '%s' "${var_root}/current"
        return 0
    fi
    printf '%s' "${dest}/runtime"
}

# 当前运行身份：root / user（默认 user）
doubao_run_mode() {
    local mode
    mode=$(head -n 1 "${TRIM_PKGVAR:-/var/apps/doubao/var}/run-mode" 2>/dev/null | tr -d '[:space:]')
    case "${mode}" in
        root) printf 'root' ;;
        *) printf 'user' ;;
    esac
}
