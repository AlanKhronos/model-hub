#!/usr/bin/env node
/**
 * model-hub MCP Server —— 把 model-hub CLI 暴露为 MCP 工具（stdio 传输）。
 *
 * 设计约束：
 *   • 传输方式：stdio（本地 CLI 工具的正确选择；stdout 留给 JSON-RPC）。
 *   • 日志纪律：所有日志走 stderr（console.error），**绝不**用 console.log——
 *     stdout 上的任何非 JSON-RPC 文本都会让客户端解析失败。
 *   • 调用 CLI：用 execFile（参数数组，不经 shell），杜绝命令注入。
 *   • 超时与缓冲：dispatch 给 5 分钟（模型调用可能很慢），只读操作 30 秒；maxBuffer 10MB。
 *
 * 暴露 4 个 tool：
 *   dispatch        —— 把文本派给多模型（fanout/run/ask）
 *   list_channels   —— 通道与额度占用（usage --days 1）
 *   strategy_rank   —— 某任务类型的通道排序（strategy --task T --json，只读）
 *   gate_stats      —— 派发闸门行为统计（gate --json，只读）
 *
 * 用法：
 *   node mcp/server.mjs                     # 直接启动（需先在 mcp/ 下 npm install）
 *   npx model-hub-mcp                       # 安装后用 bin 名
 *
 * 环境变量：与 CLI 相同（ZHIPU_API_KEY / MODELSCOPE_API_KEY / OLLAMA_URL / …），
 *   本进程继承的全部 env 透传给 CLI 子进程。
 */
import { execFile } from 'node:child_process';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';

import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';

// ─── 路径常量 ───
const __dirname = dirname(fileURLToPath(import.meta.url));
const CLI_PATH = join(__dirname, '..', 'src', 'model-hub.mjs');
const NODE = process.execPath; // 运行本进程的 node 二进制（保证版本一致）

// ─── 超时与缓冲 ───
const T_DISPATCH = 300_000;   // 5 min —— dispatch 涉及模型调用，可能很慢
const T_READONLY = 30_000;    // 30 s  —— 只读操作（usage/strategy/gate）
const MAX_BUF = 10 * 1024 * 1024; // 10 MB

// ─── stderr-only 日志：绝不用 console.log（会污染 stdout JSON-RPC）───
function log(...a) {
  console.error('[model-hub-mcp]', ...a);
}

// ─── CLI 执行器（execFile，参数数组，不经 shell）───
/**
 * @param {string[]} args 传给 CLI 的参数数组
 * @param {number} timeoutMs 超时毫秒
 * @returns {Promise<{stdout:string, stderr:string, exitCode:number}>}
 */
function runCli(args, timeoutMs = T_READONLY) {
  return new Promise((resolve) => {
    execFile(
      NODE,
      [CLI_PATH, ...args],
      {
        timeout: timeoutMs,
        maxBuffer: MAX_BUF,
        env: process.env,        // 透传全部环境变量（含 API key / OLLAMA_URL 等）
        windowsHide: true,
      },
      (err, stdout, stderr) => {
        resolve({
          stdout: stdout ? stdout.toString('utf8') : '',
          stderr: stderr ? stderr.toString('utf8') : '',
          exitCode: err ? (err.code ?? 1) : 0,
        });
      },
    );
  });
}

// ─── 临时文件：fanout/run 模式把 input 写入临时文件（避免命令行长度限制）───
async function writeTemp(text) {
  const dir = await mkdtemp(join(tmpdir(), 'mhub-mcp-'));
  const file = join(dir, 'input.txt');
  await writeFile(file, text, 'utf8');
  return { file, dir };
}

// ═══════════════════════════════════════════════════════════════
//  Tool 定义
// ═══════════════════════════════════════════════════════════════
const TOOLS = [
  {
    name: 'dispatch',
    description:
      '把一段文本派给多模型处理。' +
      'fanout=全通道并发（交叉验证/体检，所有模型都跑一遍），' +
      'run=按路由串行降级（本地优先→云端兜底，默认），' +
      'ask=单发一问（只调一个通道）。' +
      '返回 CLI 的 JSON 产出（run/ask）或人类可读摘要（fanout）。',
    inputSchema: {
      type: 'object',
      properties: {
        task: {
          type: 'string',
          description:
            '任务类型（fanout/run 模式用）。ask 模式忽略此参数。',
          enum: [
            'summarize',
            'extract',
            'classify',
            'review-code',
            'reason',
            'write-code',
          ],
        },
        input: {
          type: 'string',
          description: '要处理的文本：fanout/run 模式是材料正文，ask 模式是问题。',
        },
        mode: {
          type: 'string',
          description:
            '派发模式：fanout=全通道并发，run=串行降级保底（默认），ask=单发一问。',
          enum: ['fanout', 'run', 'ask'],
          default: 'run',
        },
        model: {
          type: 'string',
          description:
            '可选：指定通道覆盖路由（仅 run/ask 模式），如 zhipu:glm-5.3-flash。',
        },
        tokens: {
          type: 'number',
          description: '可选：max tokens 上限（影响产出长度）。',
        },
      },
      required: ['input'],
    },
  },
  {
    name: 'list_channels',
    description:
      '列出通道与额度占用（内部调 usage --days N）。' +
      '返回各家 provider 的调用次数 / 成功数 / 周期上限 / 用量占比 / 平均延迟。',
    inputSchema: {
      type: 'object',
      properties: {
        days: {
          type: 'number',
          description: '统计天数（默认 1）',
          default: 1,
        },
      },
    },
  },
  {
    name: 'strategy_rank',
    description:
      '查询某任务类型的通道排序（内部调 strategy --task T --json，只读）。' +
      '按历史成功率×延迟×成本给通道打分排序；样本不足时给中性分。',
    inputSchema: {
      type: 'object',
      properties: {
        task: {
          type: 'string',
          description: '任务类型（省略则列出全部任务的通道排序）',
          enum: [
            'summarize',
            'extract',
            'classify',
            'review-code',
            'reason',
            'write-code',
          ],
        },
        days: {
          type: 'number',
          description: '统计窗口天数（默认 7）',
          default: 7,
        },
      },
    },
  },
  {
    name: 'gate_stats',
    description:
      '派发闸门行为统计（内部调 gate --json，只读）。' +
      '统计派发/自办/直查/被拦 × 工具 × 会话。仅 DSH 环境有数据。',
    inputSchema: {
      type: 'object',
      properties: {
        days: {
          type: 'number',
          description: '统计天数（默认 0=全部时间）',
          default: 0,
        },
      },
    },
  },
];

// ═══════════════════════════════════════════════════════════════
//  Tool 分发
// ═══════════════════════════════════════════════════════════════
async function handleCall(name, args) {
  log(`call: ${name} ${JSON.stringify(args).slice(0, 200)}`);

  switch (name) {
    case 'dispatch':
      return await toolDispatch(args);
    case 'list_channels':
      return await toolListChannels(args);
    case 'strategy_rank':
      return await toolStrategyRank(args);
    case 'gate_stats':
      return await toolGateStats(args);
    default:
      return textResult(`未知工具：${name}`, true);
  }
}

// ── dispatch ──
async function toolDispatch(args) {
  const mode = args.mode ?? 'run';
  const input = args.input;
  if (!input) return textResult('缺少 input 参数', true);

  if (mode === 'ask') {
    // ask 把问题作为位置参数传入；execFile 参数数组不经 shell，无注入风险
    const cliArgs = ['ask', input];
    if (args.model) cliArgs.push('--model', String(args.model));
    if (args.tokens) cliArgs.push('--tokens', String(args.tokens));
    const r = await runCli(cliArgs, T_DISPATCH);
    return formatResult(r, `mode=ask`);
  }

  // fanout / run：把 input 写入临时文件（避免命令行长度限制，Windows ~8KB）
  const task = args.task ?? 'summarize';
  const { file, dir } = await writeTemp(input);
  try {
    const cliArgs =
      mode === 'fanout'
        ? ['fanout', '--in', file, '--task', task]
        : ['run', task, '--in', file];
    if (args.model) cliArgs.push('--model', String(args.model));
    if (args.tokens) cliArgs.push('--tokens', String(args.tokens));
    const r = await runCli(cliArgs, T_DISPATCH);
    return formatResult(r, `mode=${mode}, task=${task}`);
  } finally {
    // 清理临时目录
    await rm(dir, { recursive: true, force: true }).catch(() => {});
  }
}

// ── list_channels ──
async function toolListChannels(args) {
  const days = args.days ?? 1;
  const r = await runCli(['usage', '--days', String(days)], T_READONLY);
  return formatResult(r);
}

// ── strategy_rank ──
async function toolStrategyRank(args) {
  const cliArgs = ['strategy', '--json'];
  if (args.task) cliArgs.push('--task', String(args.task));
  if (args.days) cliArgs.push('--days', String(args.days));
  const r = await runCli(cliArgs, T_READONLY);
  return formatResult(r);
}

// ── gate_stats ──
async function toolGateStats(args) {
  const cliArgs = ['gate', '--json'];
  if (args.days) cliArgs.push('--days', String(args.days));
  const r = await runCli(cliArgs, T_READONLY);
  return formatResult(r);
}

// ─── 结果格式化：把 CLI 的 stdout/stderr/exitCode 组装成 MCP content ───
function formatResult(r, note = '') {
  const parts = [];
  if (r.stdout) parts.push(r.stdout.trimEnd());
  if (r.stderr)
    parts.push(`\n[stderr]\n${r.stderr.trimEnd()}`);
  if (note) parts.push(`\n[note] ${note}`);
  const text = parts.join('\n') || '(无输出)';
  return textResult(text, r.exitCode !== 0);
}

function textResult(text, isError = false) {
  return { content: [{ type: 'text', text }], isError };
}

// ═══════════════════════════════════════════════════════════════
//  Server 启动
// ═══════════════════════════════════════════════════════════════
const server = new Server(
  { name: 'model-hub-mcp', version: '1.0.0' },
  { capabilities: { tools: {} } },
);

server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: TOOLS,
}));

server.setRequestHandler(CallToolRequestSchema, async (req) => {
  const { name, arguments: args } = req.params;
  try {
    return await handleCall(name, args ?? {});
  } catch (e) {
    log(`error: ${e.message}`);
    return textResult(`工具执行出错：${e.message}`, true);
  }
});

const transport = new StdioServerTransport();
await server.connect(transport);
log('model-hub MCP server ready (stdio)');
