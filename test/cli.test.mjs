/**
 * CLI 黑盒测试 —— 直接以子进程方式运行 src/model-hub.mjs，断言真实 stdout / 退出码。
 *
 * 为什么不 import 源码：model-hub.mjs 是 CLI 入口，import 会执行顶层逻辑。
 * 黑盒测试反而更贴近"用户真的敲这条命令会怎样"。
 *
 * ⚠️ 这些用例**不发网络请求**（只跑本地解析/统计类子命令）。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const run = promisify(execFile);
const CLI = join(dirname(fileURLToPath(import.meta.url)), '..', 'src', 'model-hub.mjs');

async function cli(args) {
  try {
    const { stdout, stderr } = await run(process.execPath, [CLI, ...args], {
      maxBuffer: 8 * 1024 * 1024,
      timeout: 120000,
    });
    return { code: 0, stdout, stderr };
  } catch (e) {
    return { code: e.code ?? 1, stdout: e.stdout ?? '', stderr: e.stderr ?? '' };
  }
}

test('--help 列出全部子命令', async () => {
  const r = await cli(['--help']);
  assert.equal(r.code, 0, `--help 应正常退出，stderr=${r.stderr.slice(0, 200)}`);
  for (const cmd of ['list', 'probe', 'fanout', 'run', 'ask', 'usage', 'gate', 'strategy']) {
    assert.ok(r.stdout.includes(cmd), `帮助文本应包含子命令 ${cmd}`);
  }
});

test('--help 说明凭据解析顺序与关键环境变量名', async () => {
  const r = await cli(['--help']);
  assert.ok(r.stdout.includes('环境变量'), '应说明凭据顺序');
  assert.ok(r.stdout.includes('ZHIPU_API_KEY'), '应列出 key 名');
  assert.ok(r.stdout.includes('MODELHUB_CREDENTIALS'), '应说明凭据文件可覆盖');
});

test('list 能列出 provider 与通道（非空输出）', async () => {
  const r = await cli(['list']);
  assert.equal(r.code, 0, r.stderr.slice(0, 200));
  assert.ok(r.stdout.length > 200, '输出应有实质内容');
});

test('list --debug-creds 显示凭据来源', async () => {
  const r = await cli(['list', '--debug-creds']);
  assert.equal(r.code, 0, r.stderr.slice(0, 200));
  assert.ok(r.stdout.length > 200);
});

test('usage --days 1 正常退出（账本可读）', async () => {
  const r = await cli(['usage', '--days', '1']);
  assert.equal(r.code, 0, r.stderr.slice(0, 200));
  assert.ok(r.stdout.length > 0);
});

test('strategy --json 输出合法 JSON，且含 before/after/report', async () => {
  const r = await cli(['strategy', '--task', 'summarize', '--json']);
  assert.equal(r.code, 0, r.stderr.slice(0, 200));
  const j = JSON.parse(r.stdout);
  assert.ok(j.pools, '应含 pools');
  const p = j.pools.summarize;
  assert.ok(Array.isArray(p.before), 'before 应为数组');
  assert.ok(Array.isArray(p.after), 'after 应为数组');
  assert.ok(Array.isArray(p.report), 'report 应为数组');
});

test('strategy 重排不增删通道（链集合守恒）', async () => {
  const r = await cli(['strategy', '--task', 'summarize', '--json']);
  const p = JSON.parse(r.stdout).pools.summarize;
  assert.equal(p.after.length, p.before.length, '重排后长度应不变');
  assert.deepEqual([...p.after].sort(), [...p.before].sort(), '重排只是换序，不该增删通道');
});

test('strategy report 每项含评分字段（score/okRate/tier）', async () => {
  const r = await cli(['strategy', '--task', 'summarize', '--json']);
  const { report } = JSON.parse(r.stdout).pools.summarize;
  assert.ok(report.length > 0, 'report 不应为空');
  for (const row of report) {
    assert.equal(typeof row.channel, 'string');
    assert.equal(typeof row.score, 'number');
    assert.ok(row.score >= 0 && row.score <= 1, `score 应在 [0,1]，实际 ${row.score}`);
    assert.ok(['0', '1', '2'].includes(String(row.tier)), `tier 应为 0/1/2，实际 ${row.tier}`);
  }
});

test('未知任务类型 → 非零退出（参数校验生效）', async () => {
  const r = await cli(['strategy', '--task', 'no-such-task-xyz']);
  assert.notEqual(r.code, 0, '未知任务类型应报错退出');
  assert.ok(r.stderr.includes('未知任务类型'), `stderr 应说明原因，实际=${r.stderr.slice(0, 200)}`);
});
