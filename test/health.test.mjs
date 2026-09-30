/**
 * model-health.mjs 单元测试 —— 熔断 / 指数退避 / 跨天重置
 *
 * ⚠️ 关键：`MODEL_HEALTH_FILE` 必须在 **import 之前**设置好，
 *    因为模块顶层 `const FILE = process.env.MODEL_HEALTH_FILE ?? ...` 在加载时求值。
 *    所以这里用**动态 import()**，并把测试数据写到临时目录，绝不碰真实健康表。
 */
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const dir = mkdtempSync(join(tmpdir(), 'mh-test-'));
process.env.MODEL_HEALTH_FILE = join(dir, 'health.json');

const health = await import('../src/model-health.mjs');

test('初始：未知通道不跳过', () => {
  assert.equal(health.shouldSkip('zhipu:glm-4.5-flash'), false);
});

test('429 限流 → 冷却，冷却期内应跳过；基础冷却 60s', () => {
  health.onFailure('a:1', 429);
  assert.equal(health.shouldSkip('a:1'), true);
  const e = health.all()['a:1'];
  assert.equal(e.state, 'cooling');
  assert.equal(e.fails, 1);
  assert.equal(e.cooldownMs, 60 * 1000);
});

test('指数退避：连续失败冷却翻倍', () => {
  health.onFailure('b:1', 429); // 60s
  health.onFailure('b:1', 429); // 120s
  health.onFailure('b:1', 429); // 240s
  const e = health.all()['b:1'];
  assert.equal(e.fails, 3);
  assert.equal(e.cooldownMs, 240 * 1000);
});

test('指数退避上限 24h', () => {
  // 402 基础 1h，连续 10 次 → 2^9=512 倍，远超 24h，应被钳到 24h
  for (let i = 0; i < 10; i++) health.onFailure('cap:1', 402);
  assert.equal(health.all()['cap:1'].cooldownMs, 24 * 3600 * 1000);
});

test('402 额度不足 → 基础冷却 1 小时（比限流久，别急着试）', () => {
  health.onFailure('c:1', 402);
  assert.equal(health.all()['c:1'].cooldownMs, 3600 * 1000);
});

test('401/403/404 → 永久禁用（dead）', () => {
  for (const code of [401, 403, 404]) {
    const k = `dead:${code}`;
    health.onFailure(k, code);
    assert.equal(health.all()[k].state, 'dead', `HTTP ${code} 应为 dead`);
    assert.equal(health.shouldSkip(k), true);
  }
});

test('未知错误码 → 落到 error 兜底冷却（120s）', () => {
  health.onFailure('weird:1', 'something-strange');
  const e = health.all()['weird:1'];
  assert.equal(e.state, 'cooling');
  assert.equal(e.cooldownMs, 120 * 1000);
});

test('成功 → 恢复 ok / fails 清零 / 记录延迟；从冷却恢复返回 true', () => {
  health.onFailure('d:1', 429);
  const recovered = health.onSuccess('d:1', 123);
  assert.equal(recovered, true, '从 cooling 恢复应返回 true');
  const e = health.all()['d:1'];
  assert.equal(e.state, 'ok');
  assert.equal(e.fails, 0);
  assert.equal(e.delayMs, 123);
  assert.equal(health.shouldSkip('d:1'), false);
});

test('首次成功（此前无记录）不算"恢复"', () => {
  const recovered = health.onSuccess('fresh:1', 50);
  assert.equal(recovered, false);
});

test('summary 按状态分类', () => {
  const s = health.summary();
  assert.ok(Array.isArray(s.ok) && Array.isArray(s.cooling));
  assert.ok(Array.isArray(s.dead) && Array.isArray(s.stale));
  assert.ok(s.ok.some((x) => x.key === 'd:1'), 'ok 应含 d:1');
  assert.ok(s.dead.length >= 3, 'dead 应含 401/403/404');
});

test('reset(key) 只清指定通道', () => {
  health.reset('a:1');
  assert.equal(health.all()['a:1'], undefined);
  assert.ok(health.all()['b:1'], '其他通道应保留');
});

test('reset() 清空整表', () => {
  health.reset();
  assert.deepEqual(health.all(), {});
  assert.deepEqual(health.summary(), { ok: [], cooling: [], dead: [], stale: [] });
});

test('存盘：落盘结构含 __lastDay / __table', () => {
  health.onFailure('e:1', 500);
  const raw = JSON.parse(readFileSync(health.filePath(), 'utf8'));
  assert.ok(raw.__lastDay, '应有 __lastDay（跨天重置用）');
  assert.ok(raw.__table['e:1'], '应有 __table 条目');
  assert.equal(raw.__table['e:1'].state, 'cooling');
});

after(() => {
  try { rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ }
});
