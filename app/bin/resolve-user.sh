#!/bin/bash
# 解析 Web 终端应以哪个系统用户身份运行。被 install_callback / upgrade_callback /
# term 通过 source 复用，避免多处逻辑不一致。

# 是否为可登录的真人用户（排除系统/app 账号、nologin、无 HOME）
is_human_user() {
    local name="$1"
    [ -n "${name}" ] || return 1
    local entry uid shell home
    entry=$(getent passwd "${name}" 2>/dev/null) || return 1
    [ -n "${entry}" ] || return 1
    uid=$(echo "${entry}" | cut -d: -f3)
    home=$(echo "${entry}" | cut -d: -f6)
    shell=$(echo "${entry}" | cut -d: -f7)
    [ "${uid}" -ge 1000 ] 2>/dev/null || return 1
    [ "${uid}" -lt 60000 ] 2>/dev/null || return 1
    case "${shell}" in */nologin|*/false) return 1 ;; esac
    [ -d "${home}" ] || return 1
    return 0
}

# 优先取管理员组成员，否则取 UID 最小的可登录用户，最后退回 root
pick_user() {
    local fallback="" name
    for name in $(getent passwd | awk -F: '$3 >= 1000 && $3 < 60000 {print $1}'); do
        is_human_user "${name}" || continue
        if id -nG "${name}" 2>/dev/null | tr ' ' '\n' | grep -qx "Administrators"; then
            printf '%s' "${name}"
            return 0
        fi
        [ -z "${fallback}" ] && fallback="${name}"
    done
    if [ -n "${fallback}" ]; then
        printf '%s' "${fallback}"
    else
        printf '%s' "root"
    fi
}

# 给定候选（通常是 TRIM_USERNAME）优先，不合法时自动挑选
resolve_run_user() {
    local candidate="$1"
    if is_human_user "${candidate}"; then
        printf '%s' "${candidate}"
        return 0
    fi
    pick_user
}
