#!/usr/bin/env node
/**
 * model-hub MCP selftest —— 手工发 JSON-RPC 验证 stdio 协议。
 *
 * 做法：把 initialize + notifications/initialized + tools/list 三条请求
 * 用换行分隔通过 stdin 喂给 server，然后：
 *   ① 确认 stdout **只有合法 JSON-RPC 响应**（不夹带任何日志）；
 *   ② 确认 initialize 响应声明了 tools 能力；
 *   ③ 确认 tools/list 返回恰好 4 个工具（dispatch/list_channels/strategy_rank/gate_stats）；
 *   ④ 确认 stderr 含日志（证明日志走 stderr、不污染 stdout）。
 *
 * 运行：  node mcp/selftest.mjs
 * 前提：  先在 mcp/ 下 npm install（装 @modelcontextprotocol/sdk）。
 */
import { spawn } from 'node:child_process';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const SERVER = join(__dirname, 'server.mjs');

// ─── 构造三条 JSON-RPC 请求（换行分隔）───
const INIT = JSON.stringify({
  jsonrpc: '2.0',
  id: 1,
  method: 'initialize',
  params: {
    protocolVersion: '2024-11-05',
    capabilities: {},
    clientInfo: { name: 'selftest', version: '1.0.0' },
  },
});
const INITIALIZED = JSON.stringify({
  jsonrpc: '2.0',
  method: 'notifications/initialized',
});
const TOOLS_LIST = JSON.stringify({
  jsonrpc: '2.0',
  id: 2,
  method: 'tools/list',
  params: {},
});

const stdinPayload = [INIT, INITIALIZED, TOOLS_LIST].join('\n') + '\n';

// ─── 启动 server 子进程，喂 stdin，收集 stdout/stderr ───
function runServer() {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [SERVER], {
      stdio: ['pipe', 'pipe', 'pipe'],
      env: process.env,
    });

    let stdout = '';
    let stderr = '';
    let done = false;

    child.stdout.on('data', (d) => {
      stdout += d.toString('utf8');
    });
    child.stderr.on('data', (d) => {
      stderr += d.toString('utf8');
    });
    child.on('error', reject);
    child.on('close', (code) => {
      if (!done) {
        done = true;
        resolve({ stdout, stderr, code });
      }
    });

    // 写入全部请求（不立即关 stdin，给 server 时间处理）
    child.stdin.write(stdinPayload);

    // 3 秒后强制结束（server 不会自行退出：stdio transport 等 stdin EOF）
    setTimeout(() => {
      if (done) return;
      done = true;
      try {
        child.stdin.end();
      } catch {
        /* already closed */
      }
      child.kill('SIGTERM');
      resolve({ stdout, stderr, code: null });
    }, 3000);
  });
}

console.log('▶ 启动 model-hub MCP server 并发送 initialize + tools/list ...\n');

const { stdout, stderr, code } = await runServer();

console.log('════════ STDOUT ════════');
console.log(stdout);
console.log('════════ STDERR ════════');
console.log(stderr);
console.log('════════════════════════\n');

// ─── 断言 ───
let pass = 0;
let fail = 0;
function assert(cond, msg) {
  if (cond) {
    console.log(`  ✅ PASS: ${msg}`);
    pass++;
  } else {
    console.log(`  ❌ FAIL: ${msg}`);
    fail++;
  }
}

// ① stdout 每一行都必须是合法 JSON（不能有日志泄漏）
const lines = stdout.split('\n').filter(Boolean);
let allJson = true;
const responses = [];
for (const line of lines) {
  try {
    responses.push(JSON.parse(line));
  } catch {
    allJson = false;
    console.log(`  ❌ STDOUT 出现非 JSON 行: ${line.slice(0, 120)}`);
  }
}
assert(allJson, `stdout 全部 ${lines.length} 行均为合法 JSON-RPC（无日志泄漏）`);

// ② initialize 响应 (id=1)
const initResp = responses.find((r) => r.id === 1);
assert(!!initResp, '收到 initialize 响应 (id=1)');
assert(
  !!initResp?.result?.protocolVersion,
  `initialize 响应含 protocolVersion（${initResp?.result?.protocolVersion ?? '?'}）`,
);
assert(
  !!initResp?.result?.capabilities?.tools,
  'initialize 响应声明 tools 能力',
);

// ③ tools/list 响应 (id=2)
const listResp = responses.find((r) => r.id === 2);
assert(!!listResp, '收到 tools/list 响应 (id=2)');
const toolNames = (listResp?.result?.tools ?? []).map((t) => t.name);
assert(
  toolNames.length === 4,
  `tools/list 返回 4 个工具（实际 ${toolNames.length}: ${toolNames.join(', ')}）`,
);
for (const expected of [
  'dispatch',
  'list_channels',
  'strategy_rank',
  'gate_stats',
]) {
  assert(toolNames.includes(expected), `工具列表含 ${expected}`);
}

// ④ stderr 应含 "ready" 日志（证明日志走 stderr 而非 stdout）
assert(
  stderr.includes('ready'),
  'stderr 含 ready 日志（证明日志走 stderr，不污染 stdout）',
);

// ⑤ 无 JSON-RPC error 响应
const errorResp = responses.find((r) => r.error);
assert(!errorResp, '无 JSON-RPC error 响应');

console.log(`\n${fail === 0 ? '✅ ALL PASS' : '❌ HAS FAILURES'} — ${pass} pass / ${fail} fail`);
process.exit(fail === 0 ? 0 : 1);
