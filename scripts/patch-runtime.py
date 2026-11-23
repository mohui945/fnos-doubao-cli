#!/usr/bin/env python3
"""给官方豆包 CLI 运行时注入「权限档位强制」补丁。

运行时自带的权限选择会被手机端/网页端/桌面端下发覆盖，这里让 DOUBAO_PERMISSION_MODE
环境变量在 CLI 内部优先级最高：只要它非空，所有创建会话/设置权限的地方都使用该值。

输入：app/runtime/resources/js_app/{entry-cli-router,entry-cli-chat}/main.js
用法：python3 scripts/patch-runtime.py [runtime_dir]
      runtime_dir 默认 app/runtime，脚本幂等（已打过补丁会跳过）。
"""
import os
import sys

DECL = ('const __DBF=(globalThis.process&&globalThis.process.env&&'
        'globalThis.process.env.DOUBAO_PERMISSION_MODE)||"";')

ROUTER_RULES = [
    # 文件开头注入读取环境变量的声明（只替换第一次出现的 IIFE 开头）
    ('(()=>{var e,t,i,s,r,n,a,o={', '(()=>{' + DECL + 'var e,t,i,s,r,n,a,o={', 1),
    # 启动恢复权限时，环境变量存在则不再采用服务端恢复的档位
    ('!this.startupSettings.permission&&(this.preferredPermission=t.mode)',
     '!this.startupSettings.permission&&!__DBF&&(this.preferredPermission=t.mode)', 1),
    # 会话设置里构造 permission 字段
    ('permission:t?.permission??this.preferredPermission',
     'permission:(__DBF||t?.permission||this.preferredPermission)', 1),
    # 默认档位
    ('this.preferredPermission="ask_risky"',
     'this.preferredPermission=(__DBF||"ask_risky")', 1),
    # 设置权限的两条路径
    ('permission:e.level', 'permission:(__DBF||e.level)', 2),
    ('this.preferredPermission=e.level',
     'this.preferredPermission=(__DBF||e.level)', 1),
]

CHAT_RULES = [
    ('(()=>{var e={49428', '(()=>{' + DECL + 'var e={49428', 1),
    # 单次对话跑任务前，强制覆盖 permission
    ('async function G(e,t,r){let i={};t.permission&&',
     'async function G(e,t,r){let i={};(__DBF&&(t.permission=__DBF)),t.permission&&', 1),
]


def patch_file(path, rules):
    with open(path, encoding='utf-8') as f:
        src = f.read()
    if '__DBF' in src:
        print(f'[patch] 已是打过补丁的版本，跳过：{path}')
        return False
    out = src
    for old, new, expect in rules:
        got = out.count(old)
        if got != expect:
            raise SystemExit(f'[patch] 锚点数量不符（期望 {expect}，实际 {got}）：{old[:60]}… 于 {path}')
        out = out.replace(old, new)
    with open(path, 'w', encoding='utf-8') as f:
        f.write(out)
    print(f'[patch] 已注入：{path}')
    return True


def main():
    root = sys.argv[1] if len(sys.argv) > 1 else os.path.join(
        os.path.dirname(os.path.abspath(__file__)), '..', 'app', 'runtime')
    targets = [
        (os.path.join(root, 'resources/js_app/entry-cli-router/main.js'), ROUTER_RULES),
        (os.path.join(root, 'resources/js_app/entry-cli-chat/main.js'), CHAT_RULES),
    ]
    changed = 0
    for path, rules in targets:
        if not os.path.exists(path):
            raise SystemExit(f'[patch] 找不到运行时文件：{path}（先跑 scripts/fetch-deps.sh）')
        changed += 1 if patch_file(path, rules) else 0
    print(f'[patch] 完成，改动 {changed} 个文件')


if __name__ == '__main__':
    main()
