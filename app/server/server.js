'use strict';
/**
 * 豆包 CLI · fnOS 应用服务
 *
 * 职责：
 *  1. 监听 fnOS 网关下发的 unix socket，提供管理页面与 API；
 *  2. 以子进程方式管理 ttyd（Web 终端），支持一键重启；
 *  3. 提供运行身份（ROOT / 普通用户）、工作目录、上游升级等管理能力。
 *
 * 不依赖任何 npm 包，只用 Node 内置模块 + 系统 tar。
 */

const http = require('http');
const net = require('net');
const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');
const { spawn, execFile } = require('child_process');
const https = require('https');

const APP_DEST = process.env.TRIM_APPDEST || '/var/apps/doubao/target';
const APP_VAR = process.env.TRIM_PKGVAR || '/var/apps/doubao/var';
const GW_SOCKET = process.env.GATEWAY_SOCKET || 'doubao.sock';
const SOCK_PATH = path.join(APP_DEST, GW_SOCKET);
const PREFIX = (process.env.GATEWAY_PREFIX || '/app/doubao').replace(/\/+$/, '');

const TTYD_BIN = path.join(APP_DEST, 'server', 'ttyd');
const TTYD_SOCK = path.join(APP_VAR, 'ttyd.sock');
const TERM_BIN = path.join(APP_DEST, 'bin', 'term');
const UI_DIR = path.join(APP_DEST, 'ui');
const LOG_FILE = path.join(APP_VAR, 'server.log');

/* 规则：管理面板写入的指令，落盘到工作目录的 AGENTS.md，优先级高于用户提问 */
const RULES_FILE = path.join(APP_VAR, 'rules.md');
const AGENTS_FILE_NAME = 'AGENTS.md';
const AGENTS_BEGIN = '<!-- >>> 豆包规则（管理面板）· 自动生成，请勿手改此区块 >>> -->';
const AGENTS_END = '<!-- <<< 豆包规则（管理面板）结束 <<< -->';

const RUNTIME_BUNDLED = path.join(APP_DEST, 'runtime');
const RUNTIME_ROOT = path.join(APP_VAR, 'runtime');
const RUNTIME_CURRENT = path.join(RUNTIME_ROOT, 'current');

const NPM_PKG = '@bytedance/doubao-cli';
const REGISTRY = 'https://registry.npmjs.org';
const PLATFORM_KEY = 'linux-x64';

fs.mkdirSync(APP_VAR, { recursive: true });

function stamp() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

function log(line) {
  const text = `${stamp()} - ${line}\n`;
  try {
    fs.appendFileSync(LOG_FILE, text);
  } catch (_) {
    /* ignore */
  }
  process.stdout.write(text);
}

function readFileTrim(file, def = '') {
  try {
    return fs.readFileSync(file, 'utf8').trim();
  } catch (_) {
    return def;
  }
}

function readJson(file, def = null) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (_) {
    return def;
  }
}

/* ------------------------------------------------------------------ */
/* 规则（AGENTS.md）                                                    */
/* ------------------------------------------------------------------ */

function escapeRe(str) {
  return String(str).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function agentsPath() {
  return path.join(settings().workdir, AGENTS_FILE_NAME);
}

function readRules() {
  return readFileTrim(RULES_FILE, '');
}

// 把规则区块与用户原有内容拼接：规则放最前面，原有内容原样保留
function composeAgents(existing, rules) {
  const re = new RegExp(
    escapeRe(AGENTS_BEGIN) + '[\\s\\S]*?' + escapeRe(AGENTS_END) + '\\n*',
    'g'
  );
  const stripped = String(existing || '').replace(re, '').trim();
  const body = String(rules || '').trim();
  if (!body) return stripped ? stripped + '\n' : '';
  const block = AGENTS_BEGIN + '\n' + body + '\n' + AGENTS_END;
  return stripped ? block + '\n\n' + stripped + '\n' : block + '\n';
}

function applyRules(rules) {
  const body = String(rules || '').trim();
  fs.writeFileSync(RULES_FILE, body, { mode: 0o644 });
  const file = agentsPath();
  let existing = '';
  try {
    existing = fs.readFileSync(file, 'utf8');
  } catch (_) {
    existing = '';
  }
  const next = composeAgents(existing, body);
  if (!next) {
    try {
      fs.rmSync(file, { force: true });
    } catch (_) {
      /* ignore */
    }
    return { file, written: false };
  }
  fs.writeFileSync(file, next, { mode: 0o644 });
  return { file, written: true };
}

function rulesState() {
  const file = agentsPath();
  let exists = false;
  try {
    exists = fs.statSync(file).isFile();
  } catch (_) {
    /* ignore */
  }
  return { rules: readRules(), workdir: settings().workdir, agentsPath: file, agentsExists: exists };
}

/* ------------------------------------------------------------------ */
/* 积分 / 签到                                                          */
/* ------------------------------------------------------------------ */

const SESSION_FILE = path.join(APP_VAR, 'session.json');
const CREDIT_ORIGIN = 'https://www.doubao.com';
// PC Web 端固定参数：实测缺少这些参数时 /alice/commerce/... 一律 404
const QUOTA_QUERY =
  '?version_code=20800&language=zh&device_platform=web&doubao_device_platform=web' +
  '&aid=497858&real_aid=497858&pkg_type=release_version&region=CN&sys_region=CN' +
  '&samantha_web=1&web_platform=browser&use-olympus-account=1';
const QUOTA_PATHS = {
  balance: '/alice/commerce/sale/subscription/quota_balance/detail/',
  summary: '/alice/commerce/sale/subscription/quota/summary/',
  activity: '/alice/commerce/sale/subscription/activity_reward_quota/',
  campaign: '/alice/commerce/sale/campaign/page/query/',
  claim: '/alice/commerce/sale/campaign/fixed_subscription/claim/',
};

/* PC 桌面端会话：每日签到只认这套登录态（网页端没有签到卡片） */
const PC_SESSION_FILE = path.join(APP_VAR, 'pc-session.json');
const PC_UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) ' +
  'Doubao/2.37.12 Chrome/147.0.7727.149 Electron/40.0.0 Safari/537.36';
// 桌面端固定参数：aid=582478（PC 客户端），与网页端 497858 不同
const PC_QUERY_BASE =
  '?version_code=20800&language=zh&device_platform=web&doubao_device_platform=desktop' +
  '&aid=582478&real_aid=582478&pkg_type=release_version&region=CN&sys_region=CN' +
  '&samantha_web=1&web_platform=desktop&use-olympus-account=1&runtime=web&runtime_version=3.46.7' +
  '&client_platform=pc_client&chromium_version=147.0.7727.149&channel=win';
// 签到接口比查额接口更严：必须带 device_id/web_id 等客户端标识，否则报 710010702 系统错误
const PC_DEVICE_DEFAULT = { deviceId: '1659630695771851', webId: '7711169629368387087', pcVersion: '2.37.12' };

function pcQuery(pc) {
  const d = Object.assign({}, PC_DEVICE_DEFAULT, (pc && pc.device) || {});
  return (
    PC_QUERY_BASE +
    '&device_id=' + encodeURIComponent(d.deviceId) +
    '&pc_version=' + encodeURIComponent(d.pcVersion) +
    '&doubao_pc_version=' + encodeURIComponent(d.pcVersion) +
    '&web_id=' + encodeURIComponent(d.webId) +
    '&tea_uuid=' + encodeURIComponent(d.deviceId) +
    '&fp=verify_' + encodeURIComponent(d.deviceId)
  );
}
// 打卡活动的活动组 code（客户端点击「立即签到」时 body 里就这一个字段）
const SIGNIN_SCENE = 'pc_incentive_task_mvp_v3';
const SIGNIN_PATH = '/alice/ug/campaign/landing/checkin';
const RECORDS_PATH = '/alice/ug/campaign/quota/records/';

function readSession() {
  return readJson(SESSION_FILE, null);
}

function cookieHeader(session) {
  const list = (session && session.cookies) || [];
  if (!list.length) return '';
  return list.map((c) => `${c.name}=${c.value}`).join('; ');
}

async function quotaCall(pathname, body) {
  const session = readSession();
  if (!session) throw new Error('未保存网页会话（缺少 session.json）');
  const res = await fetch(CREDIT_ORIGIN + pathname + QUOTA_QUERY, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Cookie: cookieHeader(session),
      'User-Agent': session.ua || 'Mozilla/5.0',
      Origin: CREDIT_ORIGIN,
      Referer: CREDIT_ORIGIN + '/chat/',
    },
    body: JSON.stringify(body || {}),
  });
  const text = await res.text();
  let json = null;
  try {
    json = JSON.parse(text);
  } catch (_) {
    json = null;
  }
  return { status: res.status, json, text: text.slice(0, 300) };
}

function readPcSession() {
  const s = readJson(PC_SESSION_FILE, null);
  if (!s || typeof s.cookie !== 'string' || !s.cookie.trim()) return null;
  return s;
}

// PC 端会话调用：签到与额度流水都走这里
async function pcCall(pathname, body) {
  const pc = readPcSession();
  if (!pc) throw new Error('未保存 PC 端会话（缺少 pc-session.json）');
  const res = await fetch(CREDIT_ORIGIN + pathname + pcQuery(pc), {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Cookie: pc.cookie,
      'User-Agent': pc.ua || PC_UA,
      Origin: CREDIT_ORIGIN,
      Referer: CREDIT_ORIGIN + '/chat/',
    },
    body: JSON.stringify(body || {}),
  });
  const text = await res.text();
  let json = null;
  try {
    json = JSON.parse(text);
  } catch (_) {
    json = null;
  }
  return { status: res.status, json, text: text.slice(0, 300) };
}

// 额度流水：最新一条就是「每日签到」发放记录
async function pcRecords(pageSize) {
  const r = await pcCall(RECORDS_PATH, { cursor: '', page_size: pageSize || 10 });
  const list = (r.json && r.json.data && r.json.data.records) || [];
  return {
    ok: !!(r.json && r.json.code === 0),
    code: r.json ? r.json.code : null,
    msg: r.json ? r.json.msg || r.json.message || '' : String(r.text || '').slice(0, 120),
    records: list.map((x) => ({
      amount: toNum(x.amount),
      taskCode: x.task_code,
      taskName: x.task_name,
      platform: x.source_platform,
      timeMs: toNum(x.create_time_ms),
      timeText: x.create_time_ms ? formatCST(x.create_time_ms) : '',
      timeLocal: x.create_time_ms ? formatCST(Number(x.create_time_ms) + 8 * 3600 * 1000) : '',
    })),
  };
}

function toNum(v) {
  if (typeof v === 'number') return v;
  if (typeof v === 'string' && /^-?\d+(\.\d+)?$/.test(v.trim())) return Number(v);
  return null;
}

// 豆包网页端把额度到期时间戳按 UTC 展示（截图口径一致），这里手工格式化避免本机时区表异常
function formatCST(ms) {
  const d = new Date(Number(ms));
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getUTCFullYear()}/${p(d.getUTCMonth() + 1)}/${p(d.getUTCDate())} ${p(d.getUTCHours())}:${p(d.getUTCMinutes())}`;
}

// quota_balance/detail → 逐笔额度（名称/总量/已用/剩余/到期时间）
function parseQuotaBuckets(json) {
  const data = (json && json.data) || {};
  const buckets = [];
  for (const group of data.groups || []) {
    for (const it of group.items || []) {
      const total = toNum(it.total_amount);
      const used = toNum(it.used_amount);
      const remaining = total === null || used === null ? null : Math.max(total - used, 0);
      buckets.push({
        group: group.title || '',
        name: it.display_name || group.title || '额度',
        total,
        used,
        remaining,
        percent: typeof it.used_percent === 'number' ? it.used_percent : null,
        expireAt: it.end_time || 0,
        expireText: it.end_time ? formatCST(it.end_time) : '长期有效',
      });
    }
  }
  buckets.sort((a, b) => (a.expireAt || Infinity) - (b.expireAt || Infinity));
  return buckets;
}

function todayCST() {
  const d = new Date(Date.now() + 8 * 3600 * 1000);
  return d.toISOString().slice(0, 10);
}

function dateCST(ms) {
  const d = new Date(Number(ms) + 8 * 3600 * 1000);
  return d.toISOString().slice(0, 10);
}

async function creditSnapshot() {
  const session = readSession();
  const pc = readPcSession();
  const call = pc ? (p, b) => pcCall(p, b) : (p, b) => quotaCall(p, b);
  const out = {
    ok: true,
    via: pc ? 'pc' : session ? 'web' : 'none',
    hasSession: !!(session || pc),
    hasPcSession: !!pc,
    pcSavedAt: pc ? pc.savedAt || '' : '',
    sessionSavedAt: session ? session.savedAt || '' : '',
    balance: null,
    buckets: [],
    subscription: null,
    signin: {
      available: !!pc,
      today: todayCST(),
      signed: false,
      scene: SIGNIN_SCENE,
      last: null,
      records: [],
      note: '',
    },
    note: '',
    updatedAt: new Date().toISOString(),
  };
  if (!pc && !session) {
    out.note = '还没有保存任何会话：请先登录豆包 PC 客户端并粘贴其 Cookie，签到必需这套登录态。';
    out.signin.note = '未保存 PC 端 Cookie，无法签到。';
    return out;
  }
  const [bal, sum] = await Promise.all([
    call(QUOTA_PATHS.balance, { product_line: '' }).catch((e) => ({ status: 'ERR', text: e.message })),
    call(QUOTA_PATHS.summary, { product_line: '' }).catch((e) => ({ status: 'ERR', text: e.message })),
  ]);
  if (bal.json && bal.json.code === 0) {
    const data = bal.json.data || {};
    out.buckets = parseQuotaBuckets(bal.json);
    const total = toNum(data.total_remaining_amount);
    out.balance = total === null ? out.buckets.reduce((s, b) => s + (b.remaining || 0), 0) : total;
  }
  if (sum.json && sum.json.code === 0) {
    const d = sum.json.data || {};
    const cur = d.current_subscription || {};
    out.subscription = {
      name: (cur.display && cur.display.short_name) || '',
      product: (cur.display && cur.display.product_name) || '',
      status: cur.status,
      hasActive: !!(d.member_info && d.member_info.hasActiveSubscription),
    };
  }

  if (pc) {
    try {
      const rec = await pcRecords(10);
      out.signin.records = rec.records;
      const daily = rec.records.filter((r) => r.taskCode === 'daily_signin');
      const todayRec = daily.find((r) => r.timeMs && dateCST(r.timeMs) === out.signin.today);
      out.signin.last = daily[0] || null;
      out.signin.signed = !!todayRec;
      if (todayRec) out.signin.rewardToday = todayRec.amount;
      if (!rec.ok) {
        out.signin.note = '额度流水读取失败：' + (rec.msg || 'code=' + rec.code) + '（PC 端 Cookie 可能已过期）';
      } else if (!todayRec) {
        out.signin.note = '今天还没有签到记录，点「签到」领取 400 额度。';
      } else {
        out.signin.note = '今天 ' + (todayRec.timeLocal || todayRec.timeText) + ' 已签到，+' + (todayRec.amount || 400) + ' 额度已到账。';
      }
    } catch (e) {
      out.signin.note = '额度流水读取失败：' + e.message;
    }
  } else {
    out.signin.note = '未保存 PC 端 Cookie，无法签到（网页端没有签到卡片）。';
  }

  if (!out.buckets.length && out.balance === null) {
    out.note = '额度接口未返回数据（' + (bal.status === 200 ? '响应无额度分组' : 'HTTP ' + bal.status) + '）；' +
      (pc ? 'PC 端 Cookie 可能已过期，请重新粘贴。' : '网页会话可能已过期，请重新导出 session.json。');
  }
  return out;
}

async function creditSignIn() {
  const pc = readPcSession();
  const attempts = [];
  if (!pc) {
    return {
      ok: false,
      reason: '未保存 PC 端 Cookie：签到接口只在桌面客户端放量，请在「额度 · 签到」卡片里粘贴客户端 Cookie。',
      attempts,
    };
  }
  const r = await pcCall(SIGNIN_PATH, { scene: SIGNIN_SCENE }).catch((e) => ({ status: 'ERR', json: null, text: e.message }));
  const d = (r.json && r.json.data) || {};
  attempts.push({
    path: 'ug/campaign/landing/checkin',
    scene: SIGNIN_SCENE,
    status: r.status,
    code: r.json ? r.json.code : null,
    msg: 'checked_in=' + d.checked_in,
  });
  const ok = !!(r.json && r.json.code === 0 && d.checked_in);
  if (ok) log(`签到成功：${d.checkin_date} 连续 ${d.continuous_days} 天，+${d.reward_amount}`);
  const snapshot = await creditSnapshot().catch(() => null);
  if (ok) {
    return {
      ok: true,
      scene: SIGNIN_SCENE,
      date: d.checkin_date,
      continuousDays: d.continuous_days,
      rewardAmount: d.reward_amount,
      rewardType: d.reward_type,
      idempotent: !!d.idempotent,
      attempts,
      snapshot,
    };
  }
  let reason;
  const code = r.json ? r.json.code : null;
  if (code === 710012001) reason = 'PC 端会话已过期，请重新粘贴客户端 Cookie。';
  else if (r.json && r.json.msg) reason = '签到未成功：' + r.json.msg;
  else reason = '签到未成功：' + String(r.text || '').slice(0, 160);
  return { ok: false, reason, attempts, snapshot };
}

/* ------------------------------------------------------------------ */
/* 配置：运行身份 / 工作目录                                            */
/* ------------------------------------------------------------------ */

function runUser() {
  const name = readFileTrim(path.join(APP_VAR, 'run-user'), '');
  if (name && name !== 'root') return name;
  return '';
}

const PERMISSION_MODES = ['ask_always', 'ask_risky', 'always_allow'];
const PERMISSION_FILE = path.join(APP_VAR, 'permission-mode');

// 权限档位：只由本面板决定，客户端传过来的选择一律忽略
function permissionMode() {
  const v = readFileTrim(PERMISSION_FILE, '').trim();
  return PERMISSION_MODES.includes(v) ? v : 'ask_risky';
}

function writePermissionMode(mode) {
  if (!PERMISSION_MODES.includes(mode)) throw new Error('权限档位不合法');
  writeSetting('permission-mode', mode);
}

function settings() {
  const mode = readFileTrim(path.join(APP_VAR, 'run-mode'), '');
  let workdir = readFileTrim(path.join(APP_VAR, 'workdir'), '');
  const permission = permissionMode();
  if (mode !== 'root' && mode !== 'user') {
    return { mode: 'user', workdir: workdir || '/vol1', permission };
  }
  return { mode, workdir: workdir || '/vol1', permission };
}

function writeSetting(name, value) {
  const file = path.join(APP_VAR, name);
  fs.writeFileSync(file, String(value), { mode: 0o644 });
}

// 运行身份对外的展示名与 HOME
function userHome(name) {
  try {
    const entry = fs
      .readFileSync('/etc/passwd', 'utf8')
      .split('\n')
      .find((line) => line.split(':')[0] === name);
    if (entry) {
      const home = entry.split(':')[5];
      if (home) return home;
    }
  } catch (_) {
    /* ignore */
  }
  return '/root';
}

// 管理页的工作目录快捷入口：磁盘卷 + 运行用户家目录
function chips(cfgMode) {
  const out = [];
  try {
    for (const name of fs.readdirSync('/')) {
      if (/^vol[1-9]\d*$/.test(name) && fs.statSync(path.join('/', name)).isDirectory()) out.push(`/${name}`);
    }
  } catch (_) {
    /* ignore */
  }
  out.sort();
  const user = cfgMode === 'root' ? 'root' : runUser();
  if (user) {
    const home = userHome(user);
    if (fs.existsSync(home) && !out.includes(home)) out.push(home);
  }
  return out;
}

function listDir(dir) {
  const real = fs.realpathSync(dir, { throwIfNoEntry: false });
  if (!real) throw new Error('目录不存在');
  if (!fs.statSync(real).isDirectory()) throw new Error('不是文件夹');
  const dirs = [];
  for (const name of fs.readdirSync(real, { withFileTypes: true })) {
    if (name.name.startsWith('.')) continue;
    if (name.name.startsWith('@')) continue; // fnOS 系统目录，避免误选
    if (!name.isDirectory() && !name.isSymbolicLink()) continue;
    const full = path.join(real, name.name);
    let isDir = name.isDirectory();
    if (!isDir) {
      try {
        isDir = fs.statSync(full).isDirectory();
      } catch (_) {
        isDir = false;
      }
    }
    if (isDir) dirs.push({ name: name.name, path: full });
  }
  dirs.sort((a, b) => a.name.localeCompare(b.name, 'zh-CN'));
  return { path: real, parent: real === '/' ? '' : path.dirname(real), dirs };
}

function tailFrom(file, offset, lines) {
  let text = '';
  try {
    const size = fs.statSync(file).size;
    if (size <= offset) return '';
    const fd = fs.openSync(file, 'r');
    try {
      const buf = Buffer.alloc(size - offset);
      fs.readSync(fd, buf, 0, buf.length, offset);
      text = buf.toString('utf8');
    } finally {
      fs.closeSync(fd);
    }
  } catch (_) {
    return '';
  }
  const rows = text.split('\n').filter(Boolean);
  return rows.slice(Math.max(0, rows.length - lines)).join('\n');
}

function tailLog(file, lines) {
  const text = readFileTrim(file, '');
  if (!text) return '';
  const rows = text.split('\n');
  return rows.slice(Math.max(0, rows.length - lines)).join('\n');
}

/* ------------------------------------------------------------------ */
/* 运行时版本                                                          */
/* ------------------------------------------------------------------ */

function activeRuntime() {
  if (fs.existsSync(path.join(RUNTIME_CURRENT, 'doubao'))) return RUNTIME_CURRENT;
  return RUNTIME_BUNDLED;
}

function versionOf(dir) {
  const manifest = readJson(path.join(dir, 'manifest.json'));
  if (manifest && typeof manifest.version === 'string') return manifest.version;
  return '';
}

function runtimeInfo() {
  const active = activeRuntime();
  return {
    active: active === RUNTIME_CURRENT ? 'upgraded' : 'bundled',
    activeVersion: versionOf(active),
    bundledVersion: versionOf(RUNTIME_BUNDLED),
    activePath: active,
  };
}

/* ------------------------------------------------------------------ */
/* ttyd 管理                                                           */
/* ------------------------------------------------------------------ */

let ttydProc = null;

function ttydRunning() {
  return !!(ttydProc && ttydProc.exitCode === null && !ttydProc.killed);
}

function stopTtyd() {
  return new Promise((resolve) => {
    try {
      fs.rmSync(TTYD_SOCK, { force: true });
    } catch (_) {
      /* ignore */
    }
    if (!ttydRunning()) {
      ttydProc = null;
      return resolve();
    }
    const proc = ttydProc;
    let done = false;
    const finish = () => {
      if (done) return;
      done = true;
      clearTimeout(killTimer);
      ttydProc = null;
      resolve();
    };
    proc.once('exit', finish);
    try {
      proc.kill('SIGTERM');
    } catch (_) {
      finish();
    }
    const killTimer = setTimeout(() => {
      try {
        proc.kill('SIGKILL');
      } catch (_) {
        /* ignore */
      }
      finish();
    }, 4000);
  });
}

function startTtyd() {
  return new Promise((resolve, reject) => {
    if (ttydRunning()) return resolve();
    if (!fs.existsSync(TTYD_BIN)) return reject(new Error('缺少 Web 终端组件 ttyd'));
    if (!fs.existsSync(path.join(activeRuntime(), 'doubao'))) {
      return reject(new Error('缺少豆包 CLI 运行时'));
    }

    const cfg = settings();
    let workdir = cfg.workdir;
    if (!fs.existsSync(workdir) || !fs.statSync(workdir).isDirectory()) workdir = '/vol1';

    try {
      fs.rmSync(TTYD_SOCK, { force: true });
    } catch (_) {
      /* ignore */
    }

    const args = [
      '-i', TTYD_SOCK,
      '-b', `${PREFIX}/term`,
      '-W',
      '-w', workdir,
      '-m', '8',
      '-t', 'titleFixed=豆包 CLI',
      '-t', 'fontSize=14',
      '-t', 'disableLeaveAlert=true',
      '-t',
      'theme={"background":"#101216","foreground":"#E8E8EA","cursor":"#5B8CFF","selectionBackground":"#2A3550","black":"#1A1D23","red":"#FF6B6B","green":"#4ED27F","yellow":"#F2C94C","blue":"#5B8CFF","magenta":"#C084FC","cyan":"#4DD0E1","white":"#D8D8DC","brightBlack":"#5A5F6B","brightRed":"#FF8A8A","brightGreen":"#6FE39A","brightYellow":"#FFDD6B","brightBlue":"#7EA6FF","brightMagenta":"#D6A5FF","brightCyan":"#7DE6F2","brightWhite":"#FFFFFF"}',
      '--', TERM_BIN,
      '--permission-mode', cfg.permission,
    ];

    try { ensureUserSkills(); } catch (_) { /* ignore */ }
    const out = fs.openSync(path.join(APP_VAR, 'ttyd.log'), 'a');
    const proc = spawn(TTYD_BIN, args, {
      cwd: workdir,
      env: {
        ...process.env,
        TRIM_APPDEST: APP_DEST,
        TRIM_PKGVAR: APP_VAR,
        DOUBAO_WORKSPACE: workdir,
        DOUBAO_PERMISSION_MODE: cfg.permission,
        HOME: cliHome(serviceIdentity().user),
        DOUBAO_CLI_HOME: cliHome(serviceIdentity().user),
      },
      stdio: ['ignore', out, out],
    });
    ttydProc = proc;
    proc.on('exit', (code, signal) => {
      log(`ttyd 退出 code=${code} signal=${signal}`);
      ttydProc = null;
      try {
        fs.rmSync(TTYD_SOCK, { force: true });
      } catch (_) {
        /* ignore */
      }
    });
    proc.on('error', (err) => {
      log(`ttyd 启动失败：${err.message}`);
      ttydProc = null;
      reject(err);
    });
    log(`ttyd 启动 pid=${proc.pid} socket=${TTYD_SOCK} workdir=${workdir} prefix=${PREFIX}/term`);

    // 等 socket 出现，再放开给 nginx（www-data）访问
    let tries = 0;
    const timer = setInterval(() => {
      tries += 1;
      if (fs.existsSync(TTYD_SOCK)) {
        clearInterval(timer);
        try {
          fs.chmodSync(TTYD_SOCK, 0o666);
        } catch (_) {
          /* ignore */
        }
        resolve();
        return;
      }
      if (tries > 40) {
        clearInterval(timer);
        reject(new Error('ttyd 未能在 10 秒内创建 socket'));
      }
    }, 250);
  });
}

async function restartTtyd() {
  await stopTtyd();
  await startTtyd();
}

/* ------------------------------------------------------------------ */
/* 豆包后台服务任务（doubao --service-start）                          */
/* ------------------------------------------------------------------ */

const SERVICE_KEEPALIVE = path.join(APP_VAR, 'service-keepalive');
const SERVICE_LOG = path.join(APP_VAR, 'service.log');

let serviceCache = { running: false, pid: 0, uptime: '', checkedAt: 0, error: '' };
let serviceLastError = ''; // 最近一次「启动失败」的原因，状态查询不会把它冲掉
let serviceFailures = 0;
let serviceNextTryAt = 0;

// 所有服务任务操作串行化，避免「切换身份」和「守护巡检」同时动同一个 daemon
let serviceChain = Promise.resolve();

function serviceTask(fn) {
  const next = serviceChain.then(fn, fn);
  serviceChain = next.then(() => {}, () => {});
  return next;
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function doubaoBin() {
  return path.join(activeRuntime(), 'doubao');
}

// 服务任务必须和终端会话用同一身份，才能共用登录态
// 豆包的登录态、日志、键文件都落在 $HOME/.local/share/doubao_cli。
// 若沿用 /root 或 /tmp，升级、重启、系统清理 /tmp 都会让登录态消失（曾实测报 login_required）。
// 因此统一固定到持久化的应用数据目录，服务任务与终端共用同一份登录态。
function cliHome(user) {
  const name = user === 'root' ? 'root' : user;
  const dir = path.join(APP_VAR, 'home', name);
  try {
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    fs.chmodSync(dir, 0o700);
  } catch (_) {
    /* ignore */
  }
  if (user !== 'root') {
    try {
      const entry = fs
        .readFileSync('/etc/passwd', 'utf8')
        .split('\n')
        .find((line) => line.split(':')[0] === user);
      if (entry) {
        const uid = Number(entry.split(':')[2]);
        const gid = Number(entry.split(':')[3]);
        if (Number.isFinite(uid) && Number.isFinite(gid)) {
          fs.chownSync(dir, uid, gid);
          fs.chmodSync(dir, 0o700);
        }
      }
    } catch (_) {
      /* ignore */
    }
  }
  return dir;
}

function serviceIdentity(mode) {
  const cfgMode = mode || settings().mode;
  if (cfgMode === 'root') return { user: 'root', home: cliHome('root') };
  const user = runUser();
  if (!user) return { user: 'root', home: cliHome('root') };
  return { user, home: cliHome(user) };
}

/* ---------- 内置技能同步 ----------
 * 应用包内自带 skills/fnos-cli（官方 0.6.2 整包 + 预置二进制）。
 * agent 的技能目录是 $HOME/.local/share/doubao_cli/agent_mode/<id>/workspace/.user_skills，
 * 其中 .skills 是内置清单的同步副本（会被会话重建），.user_skills 才是用户技能的持久位置。
 * 安装/升级、换 HOME、新建 agent_mode 目录时，这里负责把技能补齐。
 */
const SKILL_NAME = 'fnos-cli';
const SKILL_VERSION = '0.6.2';
const SKILL_SRC = path.join(APP_DEST, 'skills', SKILL_NAME);
const SKILL_BIN_VER = '0.6.2';

function syncSkillBinary(home) {
  const src = path.join(SKILL_SRC, 'bin', 'fnos-cli');
  if (!fs.existsSync(src)) return;
  const dir = path.join(home, '.cache', 'fnos-cli', SKILL_BIN_VER, 'linux-x64');
  const dst = path.join(dir, 'fnos-cli');
  try {
    fs.mkdirSync(dir, { recursive: true });
    if (fs.existsSync(dst)) {
      const a = fs.statSync(src);
      const b = fs.statSync(dst);
      if (b.size === a.size && b.mtimeMs >= a.mtimeMs) return;
    }
    fs.copyFileSync(src, dst);
    fs.chmodSync(dst, 0o755);
    log(`已放置 ${SKILL_NAME} 二进制缓存：${dst}`);
  } catch (err) {
    log(`技能二进制同步失败：${err.message}`);
  }
}

/* 事件驱动：监听 agent_mode 目录，新会话新建 workspace 时立刻补齐技能（无轮询） */
let skillSyncTimer = null;
function scheduleSkillSync() {
  // 目录刚创建时先立刻补一次，再 300ms 后复核，尽量赶在新会话读技能清单之前
  ensureUserSkills();
  if (skillSyncTimer) clearTimeout(skillSyncTimer);
  skillSyncTimer = setTimeout(() => {
    skillSyncTimer = null;
    ensureUserSkills();
  }, 300);
  if (skillSyncTimer.unref) skillSyncTimer.unref();
}

function watchAgentMode() {
  const base = path.join(serviceIdentity().home, '.local', 'share', 'doubao_cli', 'agent_mode');
  try {
    if (!fs.existsSync(base)) {
      // 目录还没建（首次运行），监听上一层，出现即接管
      const parent = path.dirname(base);
      if (fs.existsSync(parent)) {
        const w = fs.watch(parent, (evt, name) => {
          if (!name || !String(name).includes('agent_mode')) return;
          if (fs.existsSync(base)) {
            try { w.close(); } catch (_) { /* ignore */ }
            watchAgentMode();
            scheduleSkillSync();
          }
        });
        w.on('error', () => { /* ignore */ });
      }
      return;
    }
    const w = fs.watch(base, (evt, name) => {
      if (!name) return;
      const ws = path.join(base, String(name), 'workspace');
      if (fs.existsSync(ws)) scheduleSkillSync();
    });
    w.on('error', () => { /* ignore */ });
    if (w.unref) w.unref();
  } catch (err) {
    log(`技能目录监听失败：${err.message}`);
  }
}

function ensureUserSkills() {
  try {
    if (!fs.existsSync(path.join(SKILL_SRC, 'SKILL.md'))) return;
    const id = serviceIdentity();
    const home = id.home;
    syncSkillBinary(home);
    const base = path.join(home, '.local', 'share', 'doubao_cli', 'agent_mode');
    if (!fs.existsSync(base)) return;
    for (const name of fs.readdirSync(base)) {
      const ws = path.join(base, name, 'workspace');
      if (!fs.existsSync(ws)) continue;
      const root = path.join(ws, '.user_skills');
      const dst = path.join(root, SKILL_NAME);
      const marker = path.join(dst, '.version');
      let same = false;
      try {
        same = fs.readFileSync(marker, 'utf8').trim() === SKILL_VERSION;
      } catch (_) {
        same = false;
      }
      if (same) continue;
      fs.mkdirSync(root, { recursive: true });
      fs.rmSync(dst, { recursive: true, force: true });
      fs.cpSync(SKILL_SRC, dst, {
        recursive: true,
        force: true,
        filter: (src) => !src.includes(path.join(SKILL_SRC, 'bin')),
      });
      fs.writeFileSync(marker, SKILL_VERSION, 'utf8');
      try {
        fs.chmodSync(path.join(dst, 'scripts', 'fnos-cli'), 0o755);
      } catch (_) {
        /* ignore */
      }
      log(`已同步技能 ${SKILL_NAME} 到 ${name}`);
    }
  } catch (err) {
    log(`技能同步失败：${err.message}`);
  }
}

function workdirOrTmp() {
  try {
    const wd = settings().workdir;
    if (wd && fs.statSync(wd).isDirectory()) return wd;
  } catch (_) {
    /* ignore */
  }
  return '/tmp';
}

function serviceArgv(extra, mode) {
  const bin = doubaoBin();
  const id = serviceIdentity(mode);
  if (id.user === 'root') return { file: bin, args: extra, env: null };
  return {
    file: 'runuser',
    args: [
      '-u', id.user, '--',
      'env',
      `HOME=${id.home}`,
      `USER=${id.user}`,
      `LOGNAME=${id.user}`,
      'PATH=/usr/local/bin:/usr/bin:/bin',
      bin, ...extra,
    ],
    env: null,
  };
}

function execDoubao(extra, timeout = 25000, mode) {
  const { file, args } = serviceArgv(extra, mode);
  return new Promise((resolve) => {
    execFile(file, args, { cwd: workdirOrTmp(), timeout, maxBuffer: 8 * 1024 * 1024 }, (err, stdout, stderr) => {
      resolve({ ok: !err, out: String(stdout || ''), errText: String(stderr || ''), error: err });
    });
  });
}

function parseServiceStatus(text) {
  const running = /服务任务状态[：:]\s*已开启/.test(text);
  const pid = (text.match(/服务任务进程号[：:]\s*(\d+)/) || [])[1] || '';
  const uptime = (text.match(/服务任务运行时长[：:]\s*(.+)/) || [])[1] || '';
  return { running, pid: pid ? Number(pid) : 0, uptime: uptime.trim() };
}

async function serviceStatus(fresh, mode) {
  if (!fresh && Date.now() - serviceCache.checkedAt < 5000) return serviceCache;
  const res = await execDoubao(['--service-status'], 15000, mode);
  const text = `${res.out}\n${res.errText}`;
  const parsed = parseServiceStatus(text);
  if (parsed.running) serviceLastError = '';
  serviceCache = {
    ...parsed,
    checkedAt: Date.now(),
    error: res.ok ? '' : (res.errText.trim() || '状态查询失败'),
  };
  return serviceCache;
}

// 对外暴露的服务状态（叠加最近一次启动失败原因）
function serviceView() {
  return {
    ...serviceCache,
    error: serviceLastError || serviceCache.error,
    keepalive: keepaliveEnabled(),
  };
}

function keepaliveEnabled() {
  return readFileTrim(SERVICE_KEEPALIVE, '1') !== '0';
}

function setKeepalive(on) {
  writeSetting('service-keepalive', on ? '1' : '0');
}

/**
 * 启动服务任务。豆包自己会 daemon 化（--type=service-daemon，PPID=1、fd 全指向
 * /dev/null），这里再用 detached spawn 让它落在独立会话：关终端、重开页面、
 * 甚至重启应用都不受影响。
 */
async function serviceStart() {
  try { ensureUserSkills(); } catch (_) { /* ignore */ }
  const st = await serviceStatus(true);
  if (st.running) return st;

  const bin = doubaoBin();
  if (!fs.existsSync(bin)) throw new Error('缺少豆包运行时可执行文件');
  const id = serviceIdentity();
  const perm = permissionMode();
  // 豆包 CLI 的 --service-start 是独占开关，不能与 --permission-mode 等业务参数同时
  // 出现（会报 invalid_arguments，或把前台会话当成服务任务挂住）。权限档位只作用于
  // 交互终端与 -p 批处理，服务任务保持原样启动，客户端也传不进权限参数。
  const args = id.user === 'root'
    ? ['--service-start']
    : ['-u', id.user, '--', 'env', `HOME=${id.home}`, `USER=${id.user}`, `LOGNAME=${id.user}`,
       'PATH=/usr/local/bin:/usr/bin:/bin', `DOUBAO_PERMISSION_MODE=${perm}`, bin, '--service-start'];
  const file = id.user === 'root' ? bin : 'runuser';

  let startOffset = 0;
  try {
    startOffset = fs.statSync(SERVICE_LOG).size;
  } catch (_) {
    startOffset = 0;
  }

  const out = fs.openSync(SERVICE_LOG, 'a');
  try {
    const proc = spawn(file, args, {
      cwd: workdirOrTmp(),
      env: { ...process.env, HOME: id.home, DOUBAO_CLI_HOME: id.home, DOUBAO_PERMISSION_MODE: perm },
      detached: true,
      stdio: ['ignore', out, out],
    });
    proc.unref();
  } finally {
    try {
      fs.closeSync(out);
    } catch (_) {
      /* ignore */
    }
  }

  for (let i = 0; i < 12; i += 1) {
    await delay(800);
    const now = await serviceStatus(true);
    if (now.running) {
      serviceLastError = '';
      log(`服务任务已启动 pid=${now.pid}`);
      return now;
    }
  }

  // 启动失败：只看本次启动之后写入的日志，避免把历史里成功启动的行当成失败原因
  const fresh = tailFrom(SERVICE_LOG, startOffset, 14);
  const lines = fresh.split('\n').filter(Boolean);
  const hit = lines.slice().reverse().find((l) => /login_required|invalid_arguments|未登录|error|失败/i.test(l));
  const reason = (hit || lines[lines.length - 1] || '').replace(/^\[[^\]]*\]\s*/, '').trim();
  let friendly = reason;
  if (/login_required/.test(reason)) {
    friendly = '当前身份还没登录豆包，先在「终端」里完成扫码登录（doubao login），再点「立即启动」';
  } else if (/invalid_arguments/.test(reason)) {
    friendly = '运行时拒绝了启动参数（invalid_arguments），请更新到最新版本应用后再试';
  }
  const msg = friendly ? `服务任务启动失败：${friendly}` : '服务任务未能在 10 秒内启动';
  serviceCache = { ...serviceCache, running: false, pid: 0, uptime: '', checkedAt: Date.now() };
  serviceLastError = msg;
  throw new Error(msg);
}

async function serviceStop(mode) {
  const st = await serviceStatus(true, mode);
  if (!st.running) return st;
  await execDoubao(['--service-stop'], 25000, mode);
  await delay(500);
  const after = await serviceStatus(true, mode);
  if (after.running) throw new Error('服务任务未能停止');
  log('服务任务已停止');
  return after;
}

// 守护：未运行且允许常驻时自动拉起，失败按指数退避，避免刷日志
function serviceGuard() {
  return serviceTask(async () => {
    if (Date.now() < serviceNextTryAt) return serviceCache;
    const st = await serviceStatus(true);
    if (st.running) {
      serviceFailures = 0;
      return st;
    }
    if (!keepaliveEnabled()) return st;
    log('服务任务未运行，按「保持后台运行」自动拉起');
    try {
      const started = await serviceStart();
      serviceFailures = 0;
      serviceNextTryAt = 0;
      log(`服务任务自动拉起成功 pid=${started.pid}`);
      return started;
    } catch (err) {
      serviceFailures = Math.min(serviceFailures + 1, 6);
      const backoff = Math.min(30 * 2 ** serviceFailures, 900);
      serviceNextTryAt = Date.now() + backoff * 1000;
      log(`服务任务自动拉起失败（${err.message}），${backoff} 秒后重试`);
      return serviceCache;
    }
  });
}

// 切换身份/目录后，服务任务要按新身份重建
function restartServiceForSettings(prevMode) {
  return serviceTask(async () => {
    try {
      await serviceStop(prevMode);
    } catch (err) {
      log(`停止旧服务任务失败：${err.message}`);
    }
    serviceNextTryAt = 0;
    serviceFailures = 0;
    if (!keepaliveEnabled()) return;
    try {
      const st = await serviceStart();
      log(`后台服务任务已按新身份启动 pid=${st.pid}`);
    } catch (err) {
      // 常见原因：新身份（如 ROOT）尚未登录，保留错误给页面展示
      log(`按新身份启动服务任务失败：${err.message}`);
    }
  });
}

/* ------------------------------------------------------------------ */
/* HTTP 工具                                                           */
/* ------------------------------------------------------------------ */

function sendJson(res, code, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(code, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    'Content-Length': Buffer.byteLength(body),
  });
  res.end(body);
}

function readBody(req, limit = 64 * 1024) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > limit) {
        reject(new Error('请求体过大'));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => {
      if (!chunks.length) return resolve({});
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')));
      } catch (_) {
        reject(new Error('请求体不是合法 JSON'));
      }
    });
    req.on('error', reject);
  });
}

function fetchJson(url, timeout = 20000, depth = 0) {
  return new Promise((resolve, reject) => {
    if (depth > 4) return reject(new Error('重定向过多'));
    const u = new URL(url);
    const req = https.get(
      u,
      { headers: { 'User-Agent': 'fnos-doubao-fpk', Accept: 'application/json' } },
      (res) => {
        if ([301, 302, 303, 307, 308].includes(res.statusCode)) {
          res.resume();
          return resolve(fetchJson(new URL(res.headers.location, url).toString(), timeout, depth + 1));
        }
        if (res.statusCode !== 200) {
          res.resume();
          return reject(new Error(`HTTP ${res.statusCode}`));
        }
        const chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => {
          try {
            resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')));
          } catch (err) {
            reject(new Error('响应不是合法 JSON'));
          }
        });
      }
    );
    req.setTimeout(timeout, () => req.destroy(new Error('请求超时')));
    req.on('error', reject);
  });
}

function download(url, dest, onProgress, timeout = 0, depth = 0) {
  return new Promise((resolve, reject) => {
    if (depth > 5) return reject(new Error('重定向过多'));
    const u = new URL(url);
    if (u.protocol !== 'https:') return reject(new Error('下载地址必须使用 HTTPS'));
    const req = https.get(u, { headers: { 'User-Agent': 'fnos-doubao-fpk' } }, (res) => {
      if ([301, 302, 303, 307, 308].includes(res.statusCode)) {
        res.resume();
        return resolve(download(new URL(res.headers.location, url).toString(), dest, onProgress, timeout, depth + 1));
      }
      if (res.statusCode !== 200) {
        res.resume();
        return reject(new Error(`下载失败：HTTP ${res.statusCode}`));
      }
      const total = parseInt(res.headers['content-length'] || '0', 10);
      let got = 0;
      const out = fs.createWriteStream(dest);
      res.on('data', (chunk) => {
        got += chunk.length;
        if (total && onProgress) onProgress(got / total);
      });
      res.on('error', reject);
      out.on('error', reject);
      out.on('finish', () => out.close(() => resolve()));
      res.pipe(out);
    });
    if (timeout) req.setTimeout(timeout, () => req.destroy(new Error('下载超时')));
    req.on('error', reject);
  });
}

function sha256File(file) {
  return new Promise((resolve, reject) => {
    const hash = crypto.createHash('sha256');
    const stream = fs.createReadStream(file);
    stream.on('data', (c) => hash.update(c));
    stream.on('error', reject);
    stream.on('end', () => resolve(hash.digest('hex')));
  });
}

function execFileAsync(file, args) {
  return new Promise((resolve, reject) => {
    execFile(file, args, { maxBuffer: 8 * 1024 * 1024 }, (err, stdout, stderr) => {
      if (err) return reject(Object.assign(err, { stderr }));
      resolve(stdout);
    });
  });
}

/* ------------------------------------------------------------------ */
/* 上游升级                                                            */
/* ------------------------------------------------------------------ */

let upstream = { version: '', url: '', sha256: '', root: '', size: 0, checkedAt: 0 };
let upgrade = { state: 'idle', percent: 0, message: '', version: '', error: '' };
let upgrading = false;

async function checkUpstream() {
  const latest = await fetchJson(`${REGISTRY}/${encodeURIComponent(NPM_PKG)}/latest`);
  const version = latest.version;
  const tarball = latest.dist && latest.dist.tarball;
  if (!version || !tarball) throw new Error('无法解析 npm 包信息');

  const tmp = fs.mkdtempSync(path.join(APP_VAR, '.upstream-'));
  const tgz = path.join(tmp, 'package.tgz');
  try {
    await download(tarball, tgz, null, 60000);
    await execFileAsync('tar', ['-xzf', tgz, '-C', tmp, 'package/artifacts.json']);
    const artifacts = readJson(path.join(tmp, 'package', 'artifacts.json'));
    if (!artifacts || !artifacts.platforms || !artifacts.platforms[PLATFORM_KEY]) {
      throw new Error('上游包未提供 linux-x64 运行时');
    }
    if (artifacts.version !== version) {
      throw new Error('上游清单版本与包版本不一致');
    }
    const art = artifacts.platforms[PLATFORM_KEY];
    const u = new URL(art.url);
    if (u.protocol !== 'https:') throw new Error('运行时地址不是 HTTPS');
    upstream = {
      version,
      url: art.url,
      sha256: String(art.sha256 || '').toLowerCase(),
      root: art.root,
      size: 0,
      checkedAt: Date.now(),
    };
    return upstream;
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

function validateRuntime(dir, version) {
  const manifest = readJson(path.join(dir, 'manifest.json'));
  if (!manifest) throw new Error('运行时缺少 manifest.json');
  if (manifest.schema_version !== 1) throw new Error('运行时清单版本不受支持');
  if (manifest.target !== PLATFORM_KEY) throw new Error('运行时目标平台不匹配');
  if (manifest.version !== version) throw new Error('运行时版本与上游不一致');
  if (manifest.entrypoint !== 'doubao') throw new Error('运行时入口不符');
  for (const name of ['doubao', 'update']) {
    const p = path.join(dir, name);
    if (!fs.existsSync(p)) throw new Error(`运行时缺少 ${name}`);
  }
}

async function runUpgrade() {
  if (upgrading) throw new Error('升级正在进行中');
  upgrading = true;
  upgrade = { state: 'checking', percent: 0, message: '正在检查上游版本', version: '', error: '' };
  const tmp = fs.mkdtempSync(path.join(RUNTIME_ROOT, '.upgrade-'));
  try {
    if (!upstream.version || Date.now() - upstream.checkedAt > 10 * 60 * 1000) {
      await checkUpstream();
    }
    const version = upstream.version;
    upgrade.version = version;
    log(`开始升级到 ${version}`);

    const archive = path.join(tmp, 'runtime.tar.gz');
    upgrade.state = 'downloading';
    upgrade.message = `正在下载 ${version} 运行时`;
    await download(upstream.url, archive, (p) => {
      upgrade.percent = Math.round(p * 85);
      upgrade.message = `正在下载 ${version} 运行时 ${Math.round(p * 100)}%`;
    }, 0);

    upgrade.state = 'verifying';
    upgrade.percent = 88;
    upgrade.message = '正在校验 SHA-256';
    const digest = await sha256File(archive);
    if (upstream.sha256 && digest !== upstream.sha256) {
      throw new Error('运行时 SHA-256 校验失败');
    }

    upgrade.state = 'extracting';
    upgrade.percent = 92;
    upgrade.message = '正在解包运行时';
    const extractDir = path.join(tmp, 'unpacked');
    fs.mkdirSync(extractDir);
    await execFileAsync('tar', ['-xzf', archive, '-C', extractDir]);
    const root = upstream.root;
    const staged = path.join(extractDir, root);
    if (!fs.existsSync(staged)) throw new Error('压缩包顶层目录与清单不一致');
    validateRuntime(staged, version);
    fs.chmodSync(path.join(staged, 'doubao'), 0o755);
    try {
      fs.chmodSync(path.join(staged, 'update'), 0o755);
    } catch (_) {
      /* ignore */
    }

    upgrade.state = 'switching';
    upgrade.percent = 96;
    upgrade.message = '正在切换运行时';
    const target = path.join(RUNTIME_ROOT, version);
    fs.rmSync(target, { recursive: true, force: true });
    fs.renameSync(staged, target);
    const tmpLink = `${RUNTIME_CURRENT}.tmp`;
    fs.rmSync(tmpLink, { force: true });
    fs.symlinkSync(target, tmpLink);
    fs.renameSync(tmpLink, RUNTIME_CURRENT);
    fs.writeFileSync(
      path.join(RUNTIME_ROOT, 'upstream.json'),
      JSON.stringify({ version, installedAt: new Date().toISOString(), url: upstream.url }, null, 2)
    );

    // 清理旧版本
    for (const entry of fs.readdirSync(RUNTIME_ROOT)) {
      const p = path.join(RUNTIME_ROOT, entry);
      if (entry === 'current' || entry === 'upstream.json' || p === target) continue;
      if (entry.startsWith('.upgrade-')) continue;
      try {
        fs.rmSync(p, { recursive: true, force: true });
      } catch (_) {
        /* ignore */
      }
    }

    upgrade.state = 'restarting';
    upgrade.percent = 98;
    upgrade.message = '正在重启终端与后台服务';
    await restartTtyd();
    // 运行时换了新版本，后台服务要重启才会用上新二进制
    try {
      await serviceStop();
      if (keepaliveEnabled()) await serviceStart();
    } catch (err) {
      log(`升级后重启服务任务失败：${err.message}`);
    }

    upgrade.state = 'done';
    upgrade.percent = 100;
    upgrade.message = `已升级到 ${version}`;
    log(`升级完成：${version}`);
  } catch (err) {
    upgrade.state = 'error';
    upgrade.message = '升级失败';
    upgrade.error = err.message;
    log(`升级失败：${err.stack || err.message}`);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
    upgrading = false;
  }
}

/* ------------------------------------------------------------------ */
/* 终端反向代理                                                        */
/* ------------------------------------------------------------------ */

function proxyHttp(req, res) {
  const proxyReq = http.request(
    {
      socketPath: TTYD_SOCK,
      path: req.url,
      method: req.method,
      headers: { ...req.headers, host: 'localhost' },
    },
    (proxyRes) => {
      res.writeHead(proxyRes.statusCode || 502, proxyRes.headers);
      proxyRes.pipe(res);
    }
  );
  proxyReq.on('error', (err) => {
    log(`代理请求失败：${err.message}`);
    if (!res.headersSent) {
      res.writeHead(502, { 'Content-Type': 'text/plain; charset=utf-8' });
    }
    res.end('终端服务暂不可用，请在管理页点击「重启豆包」。');
  });
  req.pipe(proxyReq);
}

function proxyUpgrade(req, socket, head) {
  const conn = net.connect(TTYD_SOCK, () => {
    const lines = [`${req.method} ${req.url} HTTP/1.1`];
    for (let i = 0; i < req.rawHeaders.length; i += 2) {
      lines.push(`${req.rawHeaders[i]}: ${req.rawHeaders[i + 1]}`);
    }
    conn.write(lines.join('\r\n') + '\r\n\r\n');
    if (head && head.length) conn.write(head);
    conn.pipe(socket);
    socket.pipe(conn);
  });
  const close = () => {
    conn.destroy();
    socket.destroy();
  };
  conn.on('error', close);
  socket.on('error', close);
  conn.on('close', close);
  socket.on('close', close);
}

/* ------------------------------------------------------------------ */
/* 路由                                                                */
/* ------------------------------------------------------------------ */

function stripPrefix(url) {
  const u = url.split('?')[0];
  if (u === PREFIX) return '/';
  if (u.startsWith(`${PREFIX}/`)) return u.slice(PREFIX.length);
  return u;
}

async function handleApi(req, res, apiPath) {
  const method = req.method || 'GET';

  if (apiPath === '/api/status' && method === 'GET') {
    const cfg = settings();
    return sendJson(res, 200, {
      mode: cfg.mode,
      workdir: cfg.workdir,
      permission: cfg.permission,
      permissionModes: ['ask_always', 'ask_risky', 'always_allow'],
      runUser: runUser() || 'root',
      chips: chips(cfg.mode),
      ttydRunning: ttydRunning(),
      ttydPid: ttydRunning() ? ttydProc.pid : 0,
      ...runtimeInfo(),
      latest: upstream.version,
      latestCheckedAt: upstream.checkedAt,
      upgrade,
      service: serviceView(),
      node: process.version,
    });
  }

  if (apiPath === '/api/service' && method === 'POST') {
    const body = await readBody(req);
    const action = String(body.action || '');
    if (action === 'start') {
      const st = await serviceStart();
      return sendJson(res, 200, { ok: true, service: serviceView() });
    }
    if (action === 'stop') {
      const st = await serviceStop();
      return sendJson(res, 200, { ok: true, service: serviceView() });
    }
    if (action === 'refresh') {
      const st = await serviceStatus(true);
      return sendJson(res, 200, { ok: true, service: serviceView() });
    }
    if (action === 'keepalive') {
      setKeepalive(!!body.enabled);
      log(`后台常驻已${body.enabled ? '开启' : '关闭'}`);
      if (body.enabled) {
        serviceNextTryAt = 0;
        serviceGuard().catch(() => {});
      }
      return sendJson(res, 200, { ok: true, service: serviceView() });
    }
    throw new Error('未知操作');
  }

  if (apiPath === '/api/list' && method === 'GET') {
    const q = new URL(req.url, 'http://localhost').searchParams.get('path') || '/';
    try {
      return sendJson(res, 200, { ok: true, ...listDir(q) });
    } catch (err) {
      return sendJson(res, 400, { ok: false, error: err.message });
    }
  }

  if (apiPath === '/api/log' && method === 'GET') {
    const n = Math.min(2000, Math.max(20, parseInt(new URL(req.url, 'http://localhost').searchParams.get('lines') || '200', 10) || 200));
    return sendJson(res, 200, {
      ok: true,
      text: tailLog(LOG_FILE, n) || tailLog(path.join(APP_VAR, 'doubao.log'), n),
    });
  }

  if (apiPath === '/api/settings' && method === 'POST') {
    const body = await readBody(req);
    const prevMode = settings().mode;
    let touched = false;
    if (body.mode !== undefined) {
      if (!['root', 'user'].includes(body.mode)) throw new Error('运行身份取值不合法');
      writeSetting('run-mode', body.mode);
      touched = true;
    }
    if (body.permission !== undefined) {
      writePermissionMode(String(body.permission).trim());
      touched = true;
    }
    if (body.workdir !== undefined) {
      const wd = String(body.workdir).trim();
      if (!wd.startsWith('/')) throw new Error('工作目录必须是绝对路径');
      const real = fs.realpathSync(wd, { throwIfNoEntry: false });
      if (!real) throw new Error('工作目录不存在');
      if (!fs.statSync(real).isDirectory()) throw new Error('工作目录不是文件夹');
      writeSetting('workdir', real);
      touched = true;
    }
    const next = settings();
    if (touched) {      // 工作目录变了：把规则同步到新目录的 AGENTS.md
      try {
        applyRules(readRules());
      } catch (_) {
        /* ignore */
      }

      // 身份或目录变了：后台服务任务要按新身份/新目录重建（旧身份要先停）
      restartServiceForSettings(prevMode).catch(() => {});
    }
    return sendJson(res, 200, { ok: true, ...next });
  }

  if (apiPath === '/api/upstream' && method === 'GET') {
    try {
      const info = await checkUpstream();
      return sendJson(res, 200, { ok: true, latest: info.version });
    } catch (err) {
      return sendJson(res, 502, { ok: false, error: err.message });
    }
  }

  if (apiPath === '/api/upgrade' && method === 'POST') {
    if (upgrading) return sendJson(res, 409, { ok: false, error: '升级正在进行中' });
    const info = runtimeInfo();
    if (upstream.version && upstream.version === info.activeVersion) {
      return sendJson(res, 200, { ok: false, error: '当前已是最新版本' });
    }
    // 后台执行，前端轮询 /api/status
    runUpgrade();
    return sendJson(res, 200, { ok: true, started: true });
  }

  if (apiPath === '/api/restart' && method === 'POST') {
    await restartTtyd();
    return sendJson(res, 200, { ok: true });
  }

  if (apiPath === '/api/rules' && method === 'GET') {
    return sendJson(res, 200, { ok: true, ...rulesState() });
  }

  if (apiPath === '/api/rules' && method === 'POST') {
    const body = await readBody(req);
    if (typeof body.rules !== 'string') throw new Error('规则内容必须是字符串');
    const applied = applyRules(body.rules);
    log(`规则已更新：${applied.written ? applied.file : '已清空并移除区块'}`);
    return sendJson(res, 200, { ok: true, ...rulesState() });
  }

  if (apiPath === '/api/credit' && method === 'GET') {
    return sendJson(res, 200, await creditSnapshot());
  }

  if (apiPath === '/api/credit/pc-session' && method === 'GET') {
    const pc = readPcSession();
    return sendJson(res, 200, {
      ok: true,
      has: !!pc,
      savedAt: pc ? pc.savedAt || '' : '',
      ua: pc ? pc.ua || PC_UA : PC_UA,
      device: pc ? Object.assign({}, PC_DEVICE_DEFAULT, pc.device || {}) : PC_DEVICE_DEFAULT,
      file: PC_SESSION_FILE,
    });
  }

  if (apiPath === '/api/credit/pc-session' && method === 'POST') {
    const body = await readBody(req);
    let cookie = typeof body.cookie === 'string' ? body.cookie.trim() : '';
    cookie = cookie.replace(/^cookie\s*:\s*/i, '').replace(/\s*\n\s*/g, '; ').replace(/;\s*;/g, ';');
    if (!cookie) throw new Error('Cookie 内容为空');
    if (!/=[^;]+/.test(cookie) || !cookie.includes(';')) throw new Error('这不像一整串 Cookie，请粘贴形如 a=1; b=2; … 的内容');
    const savedAt = new Date().toISOString();
    const ua = typeof body.ua === 'string' && body.ua.trim() ? body.ua.trim() : PC_UA;
    const device = {
      deviceId: String(body.deviceId || PC_DEVICE_DEFAULT.deviceId).trim(),
      webId: String(body.webId || PC_DEVICE_DEFAULT.webId).trim(),
      pcVersion: String(body.pcVersion || PC_DEVICE_DEFAULT.pcVersion).trim(),
    };
    fs.writeFileSync(PC_SESSION_FILE, JSON.stringify({ cookie, ua, device, savedAt }, null, 2), { mode: 0o600 });
    let check = null;
    try {
      const rec = await pcRecords(3);
      check = { ok: rec.ok, code: rec.code, msg: rec.msg || '', latest: rec.records[0] || null };
    } catch (err) {
      check = { ok: false, msg: err.message };
    }
    log('PC 端 Cookie 已更新，校验：' + (check && check.ok ? '通过' : '未通过 ' + ((check && (check.msg || 'code=' + check.code)) || '')));
    return sendJson(res, 200, { ok: true, savedAt, check });
  }

  if (apiPath === '/api/credit/pc-session' && method === 'DELETE') {
    try {
      fs.rmSync(PC_SESSION_FILE, { force: true });
    } catch (_) {
      /* ignore */
    }
    return sendJson(res, 200, { ok: true, has: false });
  }

  if (apiPath === '/api/credit/records' && method === 'GET') {
    try {
      const rec = await pcRecords(20);
      return sendJson(res, 200, { ok: rec.ok, code: rec.code, msg: rec.msg, records: rec.records });
    } catch (err) {
      return sendJson(res, 200, { ok: false, msg: err.message, records: [] });
    }
  }

  if (apiPath === '/api/credit/signin' && method === 'POST') {
    return sendJson(res, 200, await creditSignIn());
  }

  return sendJson(res, 404, { ok: false, error: '接口不存在' });
}

const server = http.createServer(async (req, res) => {
  const apiPath = stripPrefix(req.url || '/');

  try {
    if (apiPath === '/' || apiPath === '/index.html') {
      let html = fs.readFileSync(path.join(UI_DIR, 'index.html'), 'utf8');
      // 页面里用 __BASE__ 拼网关前缀，服务端注入，避免前端猜测路径
      html = html.split('__BASE__').join(PREFIX);
      const buf = Buffer.from(html, 'utf8');
      res.writeHead(200, {
        'Content-Type': 'text/html; charset=utf-8',
        'Cache-Control': 'no-store',
        'Content-Length': buf.length,
      });
      return res.end(buf);
    }

    if (apiPath === '/icon.png' || apiPath === '/icon-256.png') {
      const file = path.join(UI_DIR, 'images', apiPath === '/icon.png' ? 'icon_64.png' : 'icon_256.png');
      const img = fs.readFileSync(file);
      res.writeHead(200, { 'Content-Type': 'image/png', 'Cache-Control': 'max-age=86400' });
      return res.end(img);
    }

    if (apiPath === '/term' || apiPath.startsWith('/term/')) {
      return proxyHttp(req, res);
    }

    if (apiPath.startsWith('/api/')) {
      return await handleApi(req, res, apiPath);
    }

    res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('Not Found');
  } catch (err) {
    log(`请求处理失败 ${req.url}：${err.message}`);
    if (!res.headersSent) sendJson(res, 400, { ok: false, error: err.message });
    else res.end();
  }
});

server.on('upgrade', (req, socket, head) => {
  const apiPath = stripPrefix(req.url || '/');
  if (apiPath === '/term' || apiPath.startsWith('/term/')) {
    if (!ttydRunning()) {
      socket.destroy();
      return;
    }
    proxyUpgrade(req, socket, head);
    return;
  }
  socket.destroy();
});

/* ------------------------------------------------------------------ */
/* 启动                                                                */
/* ------------------------------------------------------------------ */

(async () => {
  try {
    fs.mkdirSync(RUNTIME_ROOT, { recursive: true });

    // 首次安装时补默认值
    if (!fs.existsSync(path.join(APP_VAR, 'run-mode'))) writeSetting('run-mode', 'user');
    if (!fs.existsSync(path.join(APP_VAR, 'workdir'))) writeSetting('workdir', '/vol1');
    // 后台服务任务默认常驻
    if (!fs.existsSync(SERVICE_KEEPALIVE)) writeSetting('service-keepalive', '1');

    // 启动时把已保存的规则重新落到工作目录，避免目录切换或重装后丢失
    try {
      applyRules(readRules());
    } catch (err) {
      log(`规则同步失败：${err.message}`);
    }

    fs.rmSync(SOCK_PATH, { force: true });
    server.listen(SOCK_PATH, () => {
      try {
        fs.chmodSync(SOCK_PATH, 0o666);
      } catch (_) {
        /* ignore */
      }
      log(`管理服务已启动：${SOCK_PATH} prefix=${PREFIX} node=${process.version}`);
    });
    server.on('error', (err) => log(`管理服务错误：${err.message}`));

    await startTtyd();
    log('终端服务就绪');

    // 安装/升级后对齐 agent 技能目录（含二进制缓存）；后续新建的 agent_mode 由文件事件触发，不做轮询
    ensureUserSkills();
    watchAgentMode();


    // 后台服务任务：默认常驻，守护线程每 30 秒确认一次
    await serviceStatus(true).catch(() => {});
    serviceGuard().catch(() => {});
    const guardTimer = setInterval(() => {
      serviceGuard().catch(() => {});
    }, 30000);
    guardTimer.unref();
    log('后台服务守护已就绪');
  } catch (err) {
    log(`启动失败：${err.stack || err.message}`);
    process.exitCode = 1;
  }
})();

function shutdown() {
  log('收到退出信号，正在关闭');
  stopTtyd().finally(() => {
    try {
      fs.rmSync(SOCK_PATH, { force: true });
    } catch (_) {
      /* ignore */
    }
    process.exit(0);
  });
}
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
