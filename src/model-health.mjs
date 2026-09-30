/**
 * model-health.mjs —— 模型健康表（熔断 + 指数退避）
 *
 * ── 解决的问题（用户 2026-09-28 提出）──
 *   额度用完的模型，会在降级链里被反复调用 → 白白浪费一次调用 + 浪费时间。
 *   而"额度会不会恢复"是**平台政策**，API 拿不到，**不能预测**。
 *
 * ── 解法：不预测，靠失败反馈自适应 ──
 *   402 / 429  → 冷却（进入 cooling，TTL 内不再调用）
 *   冷却到期   → 允许**试探一次**
 *        试探成功 → 恢复 ok
 *        试探失败 → 冷却**翻倍**（1h → 2h → 4h … 上限 24h）
 *   401/403/404 → 永久禁用（dead，需重新扫描才恢复）
 *
 *   ✅ 效果：每日/每周恢复的模型会被试探自动救活；
 *      一次性额度耗尽的模型会被"越试越久"降到几乎不再调用。
 *
 * ── 存盘 ──
 *   model-health.json（跨会话保留，今天试错的结果明天不用重踩）
 *
 * ── 用法（被 model-hub 调用）──
 *   import { shouldSkip, onSuccess, onFailure, summary } from './model-health.mjs';
 *   if (shouldSkip('sensenova:deepseek-v4-pro')) continue;   // 冷却中，跳过
 *   ... 调用 ...
 *   成功 → onSuccess(key, delayMs)
 *   失败 → onFailure(key, httpStatus)
 *
 * ── 命令行 ──
 *   node tools/model-health.mjs             # 打印健康表摘要
 *   node tools/model-health.mjs --reset     # 清空冷却（全表重置）
 *   node tools/model-health.mjs --reset k   # 重置单个 key
 */

import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import path from 'node:path';

const FILE = process.env.MODEL_HEALTH_FILE ?? path.resolve('model-health.json');
const MAX_COOLDOWN_MS = 24 * 3600 * 1000;   // 冷却上限 24 小时

/** 各类失败的基础冷却时长（毫秒）；Infinity = 永久禁用 */
const BASE_COOLDOWN = {
  429: 60 * 1000,          // 限流：1 分钟
  402: 3600 * 1000,        // 额度不足：1 小时（别急着试）
  408: 120 * 1000,         // 请求超时
  500: 300 * 1000,         // 服务端错误
  502: 300 * 1000,
  503: 300 * 1000,
  timeout: 120 * 1000,     // 本地超时
  error: 120 * 1000,
  empty: 60 * 1000,        // 返回空内容
};

const PERMANENT = new Set([401, 403, 404]);

/* ─────────────── 读写 ─────────────── */
function load() {
  if (!existsSync(FILE)) return {};
  try {
    const raw = JSON.parse(readFileSync(FILE, 'utf8'));
    const table = raw.__table ?? raw;
    const lastDay = raw.__lastDay ?? null;
    const today = new Date().toISOString().slice(0, 10);
    // 跨天自动重置：平台额度多为"每日/每周恢复"，不该被昨天的失败一直压制。
    // （若不清，指数退避会把冷却拖到 24h，明天那些已恢复的模型反而调不到。）
    if (lastDay && lastDay !== today) {
      let cleared = 0;
      for (const k of Object.keys(table)) {
        if (table[k]?.state === 'cooling') { delete table[k]; cleared++; }
      }
      try {
        writeFileSync(FILE, JSON.stringify({ __lastDay: today, __table: table }, null, 2), 'utf8');
      } catch {}
      console.error(`[model-health] 跨天重置（${lastDay} → ${today}）：清除 ${cleared} 条冷却，明天重新试探`);
    }
    return table;
  } catch { return {}; }
}
function save(table) {
  try {
    const today = new Date().toISOString().slice(0, 10);
    writeFileSync(FILE, JSON.stringify({ __lastDay: today, __table: table }, null, 2), 'utf8');
  } catch (e) {
    console.error(`[model-health] 写入失败：${e.message}`);
  }
}

let table = load();

/* ─────────────── 对外 API ─────────────── */

/** 是否应该跳过这个模型（冷却中或已死） */
export function shouldSkip(key) {
  const e = table[key];
  if (!e) return false;
  if (e.state === 'dead') return true;
  if (e.state === 'cooling' && e.until && Date.now() < e.until) return true;
  return false;   // 冷却到期 → 允许"试探一次"
}

/** 调用成功 → 恢复 */
export function onSuccess(key, delayMs = null) {
  const e = table[key] ?? {};
  const wasRecovered = e.state === 'cooling';
  e.state = 'ok';
  e.until = null;
  e.fails = 0;
  e.lastErr = null;
  e.delayMs = delayMs;
  e.checkedAt = Date.now();
  if (wasRecovered) e.recoveredAt = Date.now();
  table[key] = e;
  save(table);
  return wasRecovered;
}

/**
 * 调用失败 → 冷却
 * @param {string} key     模型标识（provider:model）
 * @param {number|string} code  HTTP 状态码或 'timeout'/'error'/'empty'
 * @param {string} note     错误摘要
 */
export function onFailure(key, code, note = '') {
  const e = table[key] ?? {};
  e.fails = (e.fails ?? 0) + 1;
  e.lastErr = String(code);
  e.note = String(note).slice(0, 100);
  e.checkedAt = Date.now();

  if (PERMANENT.has(Number(code))) {
    e.state = 'dead';
    e.until = null;
    e.reason = `永久禁用（HTTP ${code}）`;
  } else {
    const base = BASE_COOLDOWN[code] ?? BASE_COOLDOWN[Number(code)] ?? BASE_COOLDOWN.error;
    // 指数退避：第 1 次失败用基础时长，之后每次翻倍（上限 24h）
    const mult = Math.pow(2, Math.max(0, e.fails - 1));
    const cd = Math.min(base * mult, MAX_COOLDOWN_MS);
    e.state = 'cooling';
    e.cooldownMs = cd;
    e.until = Date.now() + cd;
    e.reason = `冷却 ${(cd / 1000 / 60).toFixed(0)} 分钟后可试探（第 ${e.fails} 次失败）`;
  }
  table[key] = e;
  save(table);
  return e;
}

/** 手动清除某个 key 或整表 */
export function reset(key = null) {
  if (key) delete table[key];
  else table = {};
  save(table);
}

/** 供展示：健康表摘要 */
export function summary() {
  const now = Date.now();
  const out = { ok: [], cooling: [], dead: [], stale: [] };
  for (const [k, e] of Object.entries(table)) {
    if (e.state === 'ok') out.ok.push({ key: k, delayMs: e.delayMs, checkedAt: e.checkedAt });
    else if (e.state === 'dead') out.dead.push({ key: k, reason: e.reason, err: e.lastErr });
    else if (e.state === 'cooling') {
      const left = Math.max(0, (e.until ?? 0) - now);
      const item = { key: k, leftMs: left, fails: e.fails, err: e.lastErr, reason: e.reason };
      (left > 0 ? out.cooling : out.stale).push(item);
    }
  }
  return out;
}

export function all() { return table; }
export function filePath() { return FILE; }

/* ─────────────── 命令行 ─────────────── */
const isMain = process.argv[1] && process.argv[1].replace(/\\/g, '/').endsWith('model-health.mjs');
if (isMain) {
  const args = process.argv.slice(2);
  if (args[0] === '--reset') {
    reset(args[1] ?? null);
    console.log(args[1] ? `已重置：${args[1]}` : '已重置全部健康记录');
  } else {
    const s = summary();
    const fmt = (ms) => (ms >= 3600000 ? (ms / 3600000).toFixed(1) + 'h' : ms >= 60000 ? (ms / 60000).toFixed(0) + 'min' : Math.round(ms / 1000) + 's');
    console.log(`健康表：${filePath()}`);
    console.log(`  ✅ 正常   ${s.ok.length} 个`);
    console.log(`  ⏳ 冷却中 ${s.cooling.length} 个`);
    console.log(`  ⏰ 可试探 ${s.stale.length} 个（冷却已到期，下次调用会试一次）`);
    console.log(`  🚫 永久禁用 ${s.dead.length} 个`);
    if (s.cooling.length) {
      console.log('\n  冷却中：');
      for (const c of s.cooling) console.log(`    ${c.key.padEnd(48)} 剩 ${fmt(c.leftMs).padStart(6)}  第${c.fails}次  ${c.err}`);
    }
    if (s.stale.length) {
      console.log('\n  可试探：');
      for (const c of s.stale) console.log(`    ${c.key}`);
    }
    if (s.dead.length) {
      console.log('\n  永久禁用：');
      for (const c of s.dead) console.log(`    ${c.key.padEnd(48)} ${c.reason}`);
    }
  }
}
