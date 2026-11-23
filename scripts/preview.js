#!/usr/bin/env node
'use strict';
/**
 * 本地预览服务（仅开发调试用，不打包进 fpk）
 *
 * 把已安装应用的网关 socket 反代到 127.0.0.1:PORT，方便在桌面浏览器里直接
 * 预览「终端 / 管理」页面，无需登录飞牛桌面。
 *
 *   node scripts/preview.js [port] [socket]
 */

const http = require('http');
const net = require('net');
const fs = require('fs');
const path = require('path');

const PORT = parseInt(process.argv[2] || '8977', 10);
const SOCK = process.argv[3] || '/vol1/@appcenter/doubao/doubao.sock';
const PREFIX = '/app/doubao';
const UI = path.join(__dirname, '..', 'app', 'ui', 'index.html');

function rewrite(url) {
  if (url === '/' || url === '/index.html') return PREFIX + '/';
  if (/^\/(api|term|icon)/.test(url)) return PREFIX + url;
  return url;
}

const server = http.createServer((req, res) => {
  const target = rewrite(req.url);
  if (target === `${PREFIX}/`) {
    let html = fs.readFileSync(UI, 'utf8').split('__BASE__').join('');
    const buf = Buffer.from(html, 'utf8');
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store', 'Content-Length': buf.length });
    return res.end(buf);
  }
  const proxy = http.request(
    { socketPath: SOCK, path: target, method: req.method, headers: { ...req.headers, host: 'localhost' } },
    (pr) => {
      res.writeHead(pr.statusCode || 502, pr.headers);
      pr.pipe(res);
    }
  );
  proxy.on('error', (err) => {
    res.writeHead(502, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('代理失败：' + err.message);
  });
  req.pipe(proxy);
});

server.on('upgrade', (req, socket, head) => {
  const conn = net.connect(SOCK, () => {
    const lines = [`${req.method} ${rewrite(req.url)} HTTP/1.1`];
    for (let i = 0; i < req.rawHeaders.length; i += 2) lines.push(`${req.rawHeaders[i]}: ${req.rawHeaders[i + 1]}`);
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
});

server.listen(PORT, '127.0.0.1', () => {
  console.log(`预览已启动：http://127.0.0.1:${PORT}/  (socket=${SOCK})`);
});
