#!/usr/bin/env node
/**
 * 模型中枢（Model Hub）—— 多模型集成工作流引擎
 *
 * 解决的问题：每次调用模型都要手写"用哪个 provider、哪个 model、失败了怎么办"。
 * 这里把它收敛成**一张路由表 + 一条降级链**：给任务类型，自动选模型、自动降级、统一产出。
 *
 * 设计原则
 *   1. **本地优先**：同一任务先试本地（0 成本），失败才上云端。
 *   2. **失败即降级**：任一环节失败自动切下一档，不反复重试同一模型。
 *   3. **产出必校验**：`--verify` 会跑一个校验命令（默认按 JSON 可解析性判定）。
 *   4. **配置零硬编码**：云端 key 优先读环境变量（ZHIPU_API_KEY / MODELSCOPE_API_KEY / …），
 *      回退读 ~/.dsh/.credentials.yaml（兼容旧用法）；都没有时给清晰提示（不抛难懂堆栈）。
 *
 * 用法
 *   node model-hub.mjs list                                  # 看模型清单与路由表
 *   node model-hub.mjs run <task> --in <文件|->  [--out f]   # 按任务类型走路由
 *   node model-hub.mjs run <task> --text "直接给材料"
 *   node model-hub.mjs ask "任意问题" [--model ollama:qwen2.5:7b-instruct]
 *   node model-hub.mjs probe                                 # 探测所有通道可用性
 *   node model-hub.mjs gate [--days N] [--json]              # 派发闸门统计：派发/自办/直查 × 工具 × 会话（子代理观测入口）
 *   node model-hub.mjs strategy [--task summarize]           # 策略层观测台：按历史表现给通道打分排序（只读）
 *
 * 任务类型（task）
 *   summarize    长文本摘要/压缩        extract     结构化抽取（JSON）
 *   classify     分类打标                review-code 代码审查找病灶
 *   reason       多步推理                write-code  写代码（云端）
 *   embed        向量嵌入（返回向量，不打印）
 *
 * 通道写法：`<provider>:<model>`，例如 `ollama:qwen2.5:7b-instruct`、`zhipu:glm-5.3-flash`
 */
import { readFileSync, writeFileSync, existsSync, mkdirSync, appendFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { shouldSkip, onSuccess, onFailure, all as healthAll } from './model-health.mjs';

const OLLAMA = process.env.OLLAMA_URL ?? 'http://127.0.0.1:11434';
/* 凭据文件默认位置：~/.dsh/.credentials.yaml（作者日常用法，保留兼容）。
 * 可用 MODELHUB_CREDENTIALS 环境变量覆盖路径（测试隔离 / 自定义位置 / npm 场景用）。 */
const CRED = process.env.MODELHUB_CREDENTIALS
  ? join(process.env.MODELHUB_CREDENTIALS)
  : join(homedir(), '.dsh', '.credentials.yaml');

/* 脚本固定资产目录：按脚本自身位置推导（不依赖调用时 cwd，避免「换个目录调用就读不到/写错地方」）。
 * 用法：node <任意目录>/model-hub.mjs gate 在任意 cwd 下都指向脚本同目录的 archive\。
 * 发布场景可用 MODELHUB_ARCHIVE_DIR 覆盖（npx/全局安装时建议指向可写目录）。 */
const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const ARCHIVE_DIR = process.env.MODELHUB_ARCHIVE_DIR
  ? join(process.env.MODELHUB_ARCHIVE_DIR)
  : join(SCRIPT_DIR, 'archive');

/* ────────────── 云端凭据（环境变量优先 → 凭据文件回退；不落盘、不回显）──────────────
 * 解析顺序：
 *   ① 环境变量：自动遍历 PROVIDERS 的 keyEnv（ZHIPU_API_KEY / MODELSCOPE_API_KEY /
 *      VOLCENGINE_API_KEY / MOONSHOTAI_CN_API_KEY / SENSENOVA_API_KEY / OPENROUTER_API_KEY /
 *      NVIDIA_API_KEY / GROQ_API_KEY / DEEPSEEK_API_KEY / CF_API_TOKEN），非空即生效（最高优先）；
 *   ② 凭据文件：默认 ~/.dsh/.credentials.yaml（MODELHUB_CREDENTIALS 可覆盖），一行一个 `KEY: value`，
 *      已由环境变量提供的 key 不会被文件覆盖；
 *   ③ 都没有 → 调用时抛清晰提示（列出缺哪些环境变量名），见 credHint()。 */
const CRED_SOURCE = {};   // keyEnv → 'env' | 'file'（只记录来源供 --debug-creds 展示，绝不存值）
function loadCreds() {
  const out = {};
  for (const cfg of Object.values(PROVIDERS)) {          // ① 环境变量优先
    if (!cfg.keyEnv) continue;
    const v = process.env[cfg.keyEnv];
    if (v && String(v).trim()) {
      out[cfg.keyEnv] = String(v).trim();
      CRED_SOURCE[cfg.keyEnv] = 'env';
    }
  }
  if (existsSync(CRED)) {                                 // ② 凭据文件回退
    try {
      const txt = readFileSync(CRED, 'utf8');
      for (const m of txt.matchAll(/^\s*([A-Z0-9_]+)\s*:\s*(\S+)\s*$/gm)) {
        const k = m[1];
        if (out[k]) continue;                            // 环境变量已给，文件不覆盖
        out[k] = m[2];
        CRED_SOURCE[k] = 'file';
      }
    } catch { /* 读不到就当没有 */ }
  }
  return out;
}
/* 缺失单家凭据的清晰提示（不抛难懂堆栈） */
function credHint(keyEnv, provider) {
  const file = process.env.MODELHUB_CREDENTIALS ?? join(homedir(), '.dsh', '.credentials.yaml');
  return `缺少 ${keyEnv}（provider: ${provider}）。两种配置方式任选其一：
  · 方式一（推荐）：设置环境变量  ${keyEnv}=<your key>
  · 方式二（兼容旧用法）：在凭据文件 ${file} 里写一行  ${keyEnv}: <your key>
  · 想换凭据文件位置，可设置 MODELHUB_CREDENTIALS 指向它`;
}

/* 全量缺失盘点（help / list 底部提示用） */
function describeMissingCreds() {
  const missing = Object.entries(PROVIDERS)
    .filter(([, c]) => c.keyEnv && !CREDS[c.keyEnv])
    .map(([p, c]) => `${c.keyEnv}（${p}）`);
  return missing.length
    ? `⚠️ 未配置云端凭据（${missing.length} 项）：${missing.join('、')}
   设置环境变量，或在凭据文件 ${process.env.MODELHUB_CREDENTIALS ?? join(homedir(), '.dsh', '.credentials.yaml')} 按行添加（KEY: value）。`
    : null;
}

/* ────────────── provider 注册表 ────────────── */
const PROVIDERS = {
  ollama: {
    kind: 'ollama',
    baseURL: OLLAMA,
    local: true,
    keyEnv: null,
  },
  zhipu: {
    kind: 'openai',
    baseURL: 'https://open.bigmodel.cn/api/paas/v4',
    local: false,
    keyEnv: 'ZHIPU_API_KEY',
    // 实测 2026-09-28：glm-4.7-flash / glm-4.6-flash 均返回 429（免费档访问量过大），
    // glm-4.5-flash（免费）与 glm-5.3-flash 可正常调用 → probe 用能通的免费档
    probeModel: 'glm-4.5-flash',
  },
  modelscope: {
    kind: 'openai',
    baseURL: 'https://api-inference.modelscope.cn/v1',
    local: false,
    keyEnv: 'MODELSCOPE_API_KEY',
    probeModel: 'deepseek-ai/DeepSeek-V4-Flash-0731',
  },
  'deepseek-official': {
    kind: 'openai',
    baseURL: 'https://api.deepseek.com/v1',
    local: false,
    keyEnv: 'DEEPSEEK_API_KEY',
    probeModel: 'deepseek-flash',
  },
  /* ────────── 免费档通道（2026-09-28 新增）──────────
   * key 一律写 ~/.dsh/.credentials.yaml；**没 key 的通道会在降级链里被瞬时跳过**（不发网络请求）。
   * 实测可达性：以下 6 家全部 TCP443 可直连（本机 2026-09-28）。
   * 免费额度速查：
   *   groq        30 RPM / 1000 RPD   （免费、无需信用卡）
   *   volces      每日 500 万 tokens/模型（火山方舟，国内）
   *   nvidia      40 RPM / 10000 RPD  （要 NVIDIA 开发者计划）
   *   openrouter  免费模型 50 RPD；充值≥$10 → 1000 RPD
   *   siliconflow Qwen3-8B 永久免费 / 1000 RPM（需实名）
   *   cloudflare  10000 neurons/天（baseURL 需要 CF_ACCOUNT_ID 占位替换）
   */
  groq: {
    kind: 'openai',
    baseURL: 'https://api.groq.com/openai/v1',
    local: false,
    keyEnv: 'GROQ_API_KEY',
    probeModel: 'openai/gpt-oss-20b',
  },
  volces: {   // 火山方舟：⚠️ 模型名必须用控制台「在线推理接入点」的 ep-xxxx，或已开通的模型名
    kind: 'openai',
    baseURL: 'https://ark.cn-beijing.volces.com/api/v3',
    local: false,
    keyEnv: 'VOLCENGINE_API_KEY',   // 与 DSH 凭据文件里实际使用的键名对齐（原写 ARK_API_KEY 不匹配）
    probeModel: 'doubao-seed-2-1-pro-260915',
  },
  openrouter: {
    kind: 'openai',
    baseURL: 'https://openrouter.ai/api/v1',
    local: false,
    keyEnv: 'OPENROUTER_API_KEY',
    probeModel: 'nvidia/nemotron-3.5-lightning:free',   // 实测 3.2s 出内容（原 openai/gpt-oss-20b:free 在本账号并不存在）
  },
  nvidia: {
    kind: 'openai',
    baseURL: 'https://integrate.api.nvidia.com/v1',
    local: false,
    keyEnv: 'NVIDIA_API_KEY',
    probeModel: 'openai/gpt-oss-20b',
  },
  cloudflare: {   // baseURL 里的 ${CF_ACCOUNT_ID} 从凭据文件取值（见 callOpenAI）
    kind: 'openai',
    baseURL: 'https://api.cloudflare.com/client/v4/accounts/${CF_ACCOUNT_ID}/ai/v1',
    local: false,
    keyEnv: 'CF_API_TOKEN',
    probeModel: '@cf/meta/llama-3.3-70b-instruct-fp8-fast',
  },
  /* ── 2026-10 用户已删除 siliconflow / bailian 的 API ──
   * 两家都**没有每日重置额度**（硅基=余额门槛，余额 0 连免费模型也 402；百炼=90 天一次性赠送）。
   * 已整体弃用，勿再加回；如将来要恢复，须先确认存在「每日/每周重置」的免费档。 */
  moonshot: {  // Kimi 月之暗面：⚠️ 该 key 只授权 kimi-k2.6 / kimi-k2.7-code 两个模型，其余模型名一律 404
    kind: 'openai',
    baseURL: 'https://api.moonshot.cn/v1',
    local: false,
    keyEnv: 'MOONSHOTAI_CN_API_KEY',
    probeModel: 'kimi-k2.7-code',
  },
  sensenova: {  // 商汤日日新（2026-09-28 接入）：token.sensenova.cn（OpenAI 兼容）
    kind: 'openai',
    baseURL: 'https://token.sensenova.cn/v1',
    local: false,
    keyEnv: 'SENSENOVA_API_KEY',
    probeModel: 'sensenova-6.8-flash-lite',   // ⚠️ 实测：u1-fast / u1.5-lite 均 404，只有这个能通
  },
};

/* 凭据解析必须在 PROVIDERS 定义之后执行（env 遍历依赖 keyEnv 注册表） */
const CREDS = loadCreds();
const ALL_KEY_ENVS = [...new Set(Object.values(PROVIDERS).map((c) => c.keyEnv).filter(Boolean))];

/* ────────────── 路由表：任务类型 → 降级链（本地优先，云端兜底） ────────────── */
const ROUTES = {
  // 降级顺序（2026-10 更新：siliconflow / bailian 已弃用；用户批准的云端序）
  //   本地(0成本) → 智谱glm-4-flash(永久免费·日重置) → 魔搭(2000次/天) → 火山(每日额度)
  //   → 商汤(每周重置) → 智谱glm-5.3-flash(资源包·付费) → Kimi(体验金·用完即止)
  summarize: ['ollama:qwen2.5:7b-instruct', 'zhipu:glm-4-flash', 'modelscope:deepseek-ai/DeepSeek-V4-Flash-0731', 'volces:doubao-seed-2-1-pro-260915', 'sensenova:sensenova-6.8-flash-lite', 'zhipu:glm-5.3-flash', 'moonshot:kimi-k2.7-code'],
  extract: ['ollama:qwen2.5:7b-instruct', 'zhipu:glm-4-flash', 'modelscope:deepseek-ai/DeepSeek-V4-Flash-0731', 'volces:doubao-seed-2-1-pro-260915', 'sensenova:sensenova-6.8-flash-lite', 'zhipu:glm-5.3-flash', 'moonshot:kimi-k2.7-code'],
  classify: ['ollama:qwen2.5:7b-instruct', 'zhipu:glm-4-flash', 'modelscope:deepseek-ai/DeepSeek-V4-Flash-0731', 'volces:doubao-seed-2-1-pro-260915', 'sensenova:sensenova-6.8-flash-lite', 'zhipu:glm-5.3-flash', 'moonshot:kimi-k2.7-code'],
  'review-code': ['ollama:qwen2.5-coder:7b', 'zhipu:glm-4-flash', 'modelscope:deepseek-ai/DeepSeek-V4-Flash-0731', 'volces:doubao-seed-2-1-pro-260915', 'sensenova:sensenova-6.8-flash-lite', 'zhipu:glm-5.3-flash'],
  // reason 走推理档：glm-5.2（用户查到每日 300 万 tokens，实测 1069ms 通）优先
  reason: ['ollama:deepseek-r1:7b', 'zhipu:glm-5.2', 'modelscope:deepseek-ai/DeepSeek-V4-Pro', 'zhipu:glm-5.3-flashx', 'sensenova:sensenova-6.8-flash-lite', 'volces:doubao-seed-2-1-pro-260915'],
  'write-code': ['zhipu:glm-4-flash', 'modelscope:deepseek-ai/DeepSeek-V4-Flash-0731', 'volces:doubao-seed-2-1-pro-260915', 'sensenova:sensenova-6.8-flash-lite', 'zhipu:glm-5.3-flash', 'moonshot:kimi-k2.7-code'],
  embed: ['ollama:bge-m3'],
  // 实测延迟（2026-10）：glm-4-flash 545ms / glm-4v-flash 217ms / glm-4-air 362ms / glm-5.2 1069ms
  //   glm-5.3-flash 889ms / glm-5.3-flashx 863ms / 火山 2.4s / 魔搭 V4-Flash 1.9s / Kimi 1.3s / 商汤 883ms
  // 智谱不可用名：glm-4.7-flash(429 拥堵·非无权限·暂时留着待恢复) / glm-4.6-flash(403 无权访问)
  // 火山坑：只有 doubao-seed-2-1-pro-260915 通；doubao-pro-32k-241215 等老名一律 404
  // 仍测不通的模型：MiniMax/MiniMax-M3、ZhipuAI/GLM-5.2（魔搭侧调用返回 null）
};

/* ────────────── 调用实现 ────────────── */
function splitChannel(ch) {
  const i = ch.indexOf(':');
  return { provider: ch.slice(0, i), model: ch.slice(i + 1) };
}

async function callOllama(model, prompt, opts) {
  // 嵌入走 /api/embed，其余走 /api/chat
  if (opts.task === 'embed') {
    const r = await fetch(`${OLLAMA}/api/embed`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model, input: prompt }),
      signal: AbortSignal.timeout(opts.timeoutMs),
    });
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    const d = await r.json();
    return { text: '', embedding: d.embeddings?.[0] ?? null };
  }
  const r = await fetch(`${OLLAMA}/api/chat`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      model,
      messages: [{ role: 'user', content: prompt }],
      stream: false,
      options: { temperature: opts.temperature, num_predict: opts.maxTokens },
    }),
    signal: AbortSignal.timeout(opts.timeoutMs),
  });
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  const d = await r.json();
  return { text: d?.message?.content ?? '' };
}

async function callOpenAI(provider, model, prompt, opts) {
  const cfg = PROVIDERS[provider];
  const key = cfg.keyEnv ? CREDS[cfg.keyEnv] : null;
  if (!key) throw new Error(credHint(cfg.keyEnv, provider));
  // baseURL 支持 ${VAR} 占位（如 Cloudflare 的 ${CF_ACCOUNT_ID}）：环境变量优先，其次凭据文件
  const base = cfg.baseURL.replace(/\$\{(\w+)\}/g, (_, k) => {
    const v = process.env[k] ?? CREDS[k];
    if (!v) throw new Error(`缺少 ${k}（baseURL 占位符需要它，可设环境变量或写进凭据文件）`);
    return v;
  });
  // 部分模型只接受固定的 temperature（实测 Kimi kimi-k2.7-code 要求必须为 1），
  // 因此当 400 且报错含 "temperature" 时，自动去掉该参数重试一次，避免整条链被误判为不可用。
  const send = (withTemp) => fetch(`${base}/chat/completions`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${key}` },
    body: JSON.stringify({
      model,
      messages: [{ role: 'user', content: prompt }],
      ...(withTemp ? { temperature: opts.temperature } : {}),
      max_tokens: opts.maxTokens,
      stream: false,
    }),
    signal: AbortSignal.timeout(opts.timeoutMs),
  });
  let r = await send(true);
  if (!r.ok && r.status === 400) {
    const peek = await r.text().catch(() => '');
    if (/temperature/i.test(peek)) {
      r = await send(false);
    } else {
      throw new Error(`HTTP ${r.status}${peek ? ' ' + peek.slice(0, 120) : ''}`);
    }
  }
  if (!r.ok) {
    const body = await r.text().catch(() => '');
    throw new Error(`HTTP ${r.status}${body ? ' ' + body.slice(0, 120) : ''}`);
  }
  const d = await r.json();
  const choice = d?.choices?.[0] ?? {};
  const msg = choice.message ?? {};
  let text = msg.content ?? '';
  let onlyReasoning = false;

  // ⚠️ 实测坑（2026-09-27）：智谱 glm-5.3-flash 是**推理型**模型，
  // max_tokens 太小时它把额度全花在思考上 → content 为空、只有 reasoning_content、
  // finish_reason 变成 "length"。此时把思考内容兜出来并标记，避免上游拿到空串。
  if (!text && msg.reasoning_content) {
    text = msg.reasoning_content;
    onlyReasoning = true;
  }
  return { text, onlyReasoning, finishReason: choice.finish_reason, usage: d?.usage };
}

/* ────────────── 资源限额（依据 tools/QUOTA-LIMITS.md 的实测结论）────────────── */
// 各家并发上限：超了会 429 或超时（实测火山并发 8 → 3 路 180s 超时；商汤直接 429）
const PROVIDER_CONCURRENCY = {
  ollama: 1,        // 单卡 8GB，并发只会互相抢显存
  sensenova: 1,     // TPM/RPM 限速 → 必须串行
  moonshot: 1,      // RPM 限流
  volces: 2,        // 高并发即超时
  openrouter: 2,    // 50 次/天，慢点无妨
  zhipu: 2,         // 免费档并发低
};
const DEFAULT_CONCURRENCY = 6;

// 个别模型对 max_tokens 有硬上限（实测 zhipu:glm-4v-flash 报「限制数值范围[1,1024]」）
const MAX_TOKENS_CAP = {
  'zhipu:glm-4v-flash': 1024,
};

// 周期额度（供 `model-hub usage` 对照；limit=null 表示按 token 计或未明确）
const PERIOD_QUOTA = {
  nvidia: { limit: 10000, unit: '次/天' },
  modelscope: { limit: 2000, unit: '次/天' },
  openrouter: { limit: 50, unit: '次/天' },
  sensenova: { limit: null, unit: '每周重置' },
  volces: { limit: null, unit: '每日 token' },
  zhipu: { limit: null, unit: '每日/每月' },
  moonshot: { limit: null, unit: '体验金' },
  ollama: { limit: Infinity, unit: '无限' },
};

/* 额度账本：每次真实调用落一行 JSONL（append-only）——"用过哪些模型"从此有数字，不靠自述 */
function logUsage(entry) {
  try {
    const dir = ARCHIVE_DIR;
    mkdirSync(dir, { recursive: true });
    appendFileSync(join(dir, 'usage.jsonl'), JSON.stringify(entry) + '\n', 'utf8');
  } catch { /* 记账失败绝不影响主流程 */ }
}

/* ══════════ 策略层：按「历史成功率 × 延迟 × 成本档」自动选优（v1 落地，2026-10）══════════
 * 数据源：tools/archive/usage.jsonl（callChannel 每次真实调用都落一行，见上方 logUsage）。
 * 职责边界（本版只做 run 侧）：只决定 run 候选链的顺序——不改 runChain 串行降级、不截链；
 * fanout 侧**不接线**（审查结论：Promise.all 要等最慢通道，重排只改归档顺序收益≈0；
 * 且 callChannel 不查 shouldSkip，broken 通道照调反而恶化熔断）——fanout 行为保持原样，
 * rankFanoutChannels 因此不收录（不留死代码）。strategy 子命令里的 fanout 池仅只读观测。
 * 三条守则：
 *   1. 本地优先不回退：tier0 通道没坏透（成功率 ≥ 0.5 且未熔断、非全失败）就置顶，保持 v1 语义；
 *      本地明显坏掉才让免费云上位——这正是策略层的核心增益。
 *   2. 熔断是硬状态：冷却中的通道沉底（runChain 反正会跳过），不参与打分排序。
 *   3. 样本不足不冤枉：少于 MIN_SAMPLES 条记录按"无历史"给中性分，新通道不永久垫底。
 */

// 统计窗口：太短样本少、太长过时（通道可用性是时变的，见 QUOTA-LIMITS.md 实测记录）
const STRATEGY_DAYS = 7;
const MIN_SAMPLES = 10;         // 少于 10 条 → 按"无历史"处理（3 条统计无意义：一次偶发就从 0% 跳到 100%，是断崖不是过渡）
const LATENCY_REF_MS = 3000;    // 延迟参照：平均 ≤3s 得满分，越慢分越低
const HALF_LIFE_DAYS = 3;       // 时间衰减半衰期：3 天前的样本权重减半（近期表现更能代表通道当前状态）
const SCORE_WEIGHTS = {
  ok: 0.55, latency: 0.25,
  // cost 0.20（审查裁定 0.30 统计上站不住，压到 0.15~0.20 区间上缘）。显式 trade-off：
  // 保留 0.20 是为了让"同成功率下免费档仍排前"，但它**不会**淹没成功率信号——
  // 档位差最大 0.65-0.30=0.35，乘 0.20 只有 0.07 分差，okRate 每差 13 个百分点即可抹平。
  // 即：本策略宁可要 80% 成功的免费通道，也不会因成本把 100% 成功的通道踩到后面；
  // 成本侧的真正保护由 localFirst 守门（tier0 置顶）承担，不靠这个权重硬扛。
  cost: 0.20,
};
const NEUTRAL = 0.7;            // "无历史"维度的中性分（不奖不罚：1.0 会捧杀，0 会永久埋没）

/* 成本档：0=本地(0 元) < 1=免费额度(日/周重置) < 2=资源包/体验金(用完即止)。
 * 先查通道级精确档（同一家不同模型成本可能不同），查不到再按 provider 默认档；
 * 未知 provider 按最贵档处理（宁保守，不打错折）。维护口径见 tools/QUOTA-LIMITS.md。 */
const CHANNEL_COST_TIER = {
  // —— 资源包 / 体验金（付费，用完即止）——
  'zhipu:glm-5.3-flash': 2,  'zhipu:glm-5.3-flashx': 2,  'zhipu:glm-5.2': 2,
  'moonshot:kimi-k2.6': 2,   'moonshot:kimi-k2.7-code': 2,
};
const PROVIDER_COST_TIER = {
  ollama: 0,       // 本地 0 元、无额度概念（唯一真正无限）
  zhipu: 1,        // glm-4-flash / 4v-flash / 4-air / 4.5-flash 永久免费
  modelscope: 1,   // 每日 2000 次（UTC+8 重置）
  volces: 1,       // 每日 token 额度
  sensenova: 1,    // 每周重置
  nvidia: 1,       // 10000 次/天
  openrouter: 1,   // 免费模型 50 次/天（额度最小，但仍是免费档）
  groq: 1,  cloudflare: 1,
  moonshot: 2,     // 整家都是体验金
};

function costTier(channel) {
  if (CHANNEL_COST_TIER[channel] != null) return CHANNEL_COST_TIER[channel];
  return PROVIDER_COST_TIER[channel.split(':')[0]] ?? 2;
}

/* 读账本 → 按「完整通道」聚合（cmdUsage 按 provider 聚是给人看的报表，这里按通道聚：
 * 同一家不同模型表现差异大，如 zhipu:glm-4-flash(免费·快) vs zhipu:glm-5.3-flash(付费·推理型)）。
 * 加权口径：每条样本按 0.5^(ageDays/HALF_LIFE_DAYS) 衰减加权（ageDays = 样本距今天数），
 *   近期样本权重大 → 通道"最近变好/变坏"能在一两次调用内反映出来；
 *   okRate/均延用加权值计算，samples（条数）用原始计数——MIN_SAMPLES 判"够不够统计"，
 *   时间衰减只影响"值"、不影响"有没有资格算值"，两个维度正交。
 * 进程内 memo：本脚本每次 CLI 就是一个进程，读一次足够；不做跨进程缓存
 * （缓存文件会引入过期/写失败两个新故障面，还会漏掉最近一次调用）。
 * file 参数：默认真账本；--ledger 可指向隔离账本（自测/演练用，见 cmdStrategy）。 */
let _strategyStats = null;
function loadUsageStats({ days = STRATEGY_DAYS, file = null } = {}) {
  if (_strategyStats) return _strategyStats;
  const map = new Map();                       // channel → { ok, fail, okW, failW, msSumW, okWSum, lastAt }
  const path = file ?? join(ARCHIVE_DIR, 'usage.jsonl');
  if (!existsSync(path)) return (_strategyStats = map);
  const now = Date.now();
  const since = now - days * 86400_000;
  try {
    for (const line of readFileSync(path, 'utf8').split('\n')) {
      if (!line) continue;
      let r; try { r = JSON.parse(line); } catch { continue; }   // 坏行跳过，与 cmdUsage 同款
      const ts = new Date(r.at).getTime();
      if (!Number.isFinite(ts) || ts < since) continue;
      // 时间衰减权重：半衰期 HALF_LIFE_DAYS 天，零依赖实现（Math.pow）
      const w = Math.pow(0.5, Math.max(0, now - ts) / (HALF_LIFE_DAYS * 86400_000));
      const e = map.get(r.channel) ?? { ok: 0, fail: 0, okW: 0, failW: 0, msSumW: 0, okWSum: 0, lastAt: 0 };
      if (r.ok) { e.ok++; e.okW += w; e.msSumW += (r.ms ?? 0) * w; e.okWSum += w; }
      else { e.fail++; e.failW += w; }
      e.lastAt = Math.max(e.lastAt, ts);
      map.set(r.channel, e);
    }
  } catch { /* 账本读不到 → 全部按"无历史"处理，策略层静默退化为原顺序 */ }
  return (_strategyStats = map);
}

/* 单通道打分：score ∈ [0,1]，越高越优先。纯内存计算，不做任何 IO。
 * 评分示例（权重 0.55/0.25/0.20，数字手工可复算；修正原方案 §1.3 的算术错误）：
 *   本地 7B ·90%·均6.5s     → 0.55×0.90 + 0.25×(3000/6500) + 0.20×1.00 ≈ 0.810（置顶靠守门，不靠分数）
 *   zhipu:glm-4-flash ·95%·545ms → 0.55×0.95 + 0.25×1.00 + 0.20×0.65 ≈ 0.903（免费组第一）
 *   无历史免费通道（全中性）  → 0.55×0.70 + 0.25×0.70 + 0.20×0.65 = 0.690
 *   Kimi(体验金) ·100%·1.3s  → 0.55×1.00 + 0.25×1.00 + 0.20×0.30 = 0.860（付费组第一）
 */
function scoreChannel(channel, stats) {
  const s = stats.get(channel);
  const samples = s ? s.ok + s.fail : 0;                     // 原始条数：判 MIN_SAMPLES 用
  // ① 加权成功率（样本 ≥ MIN_SAMPLES 才算真值，否则中性分）；近期样本权重大（半衰期 3 天）
  const okRate = samples >= MIN_SAMPLES ? s.okW / (s.okW + s.failW) : NEUTRAL;
  // ② 加权平均延迟：只算成功调用的 ms——失败路径的耗时（401 立返 / 60s 超时）混进来会污染延迟分；
  //    失败本身已由成功率维度惩罚。无成功样本给中性分。
  const latencyScore = s && s.ok > 0
    ? Math.max(0, Math.min(1, LATENCY_REF_MS / Math.max(s.msSumW / s.okWSum, 1)))
    : NEUTRAL;
  // ③ 成本档 → 分：tier0=1.0 / tier1=0.65 / tier2=0.30
  const tier = costTier(channel);
  const costScore = [1, 0.65, 0.3][tier] ?? 0.3;
  // ④ 熔断与"全失败"：不走加权，走硬排序——熔断沉底；只有失败没有成功的排到所有有成功记录者之后
  const broken = shouldSkip(channel);                       // 与 runChain 同款判断，两处语义永远一致
  const allFailed = !!s && s.ok === 0 && s.fail > 0;
  const score = SCORE_WEIGHTS.ok * okRate + SCORE_WEIGHTS.latency * latencyScore + SCORE_WEIGHTS.cost * costScore;
  const health = broken ? healthAll()[channel] : null;
  const avgMs = s && s.ok > 0 ? Math.round(s.msSumW / s.okWSum) : null;
  return {
    channel, score, okRate, avgMs, tier, samples, broken, allFailed, lastAt: s?.lastAt ?? 0,
    reason: `成功率${(okRate * 100).toFixed(0)}%(n=${samples})`
      + ` 均延${avgMs == null ? '无样本' : avgMs + 'ms'}`
      + ` 档${tier} 分${score.toFixed(3)}`
      + (broken ? ` ⛔熔断(${health?.reason ?? ''})` : '') + (allFailed ? ' ⛔全失败' : ''),
  };
}

/* 主入口：静态链 → 选优链（run/cmdRun 用）。
 * 返回 { chain: 重排后的链, report: 逐通道评分明细 }。链元素集合与入参完全一致（只重排、不增删）。
 * 防御：入参不是数组（如非法 task 传进 undefined）→ 原样返回、绝不抛错——
 *       cmdRun 已有前置校验，这里是双保险（审查 A 条：方案原稿在此处栈崩、丢掉优雅报错）。 */
function rankChain(chain, { localFirst = true, days = STRATEGY_DAYS, file = null } = {}) {
  if (!Array.isArray(chain)) return { chain, report: [] };
  const stats = loadUsageStats({ days, file });
  const rows = chain.map((ch) => scoreChannel(ch, stats));
  const byRank = (a, b) => (a.allFailed - b.allFailed) || (b.score - a.score);  // 全失败沉底，再按分数
  const healthy = rows.filter((r) => !r.broken).sort(byRank);
  const broken = rows.filter((r) => r.broken);       // 熔断 → 沉底（runChain 会跳过，保留是为归档留痕）
  let ordered = [...healthy];
  // 本地优先守门：tier0 通道只要没坏透（成功率≥0.5、非全失败、未熔断）就强制置顶——保持 v1"本地优先"语义
  if (localFirst) {
    const locals = ordered.filter((r) => r.tier === 0 && r.okRate >= 0.5 && !r.allFailed);
    if (locals.length) {
      const set = new Set(locals.map((r) => r.channel));
      ordered = [...locals.sort(byRank), ...ordered.filter((r) => !set.has(r.channel))];
    }
  }
  return { chain: [...ordered, ...broken].map((r) => r.channel), report: [...ordered, ...broken] };
}

/* 策略观测台：node model-hub.mjs strategy [--task summarize] [--days 7] [--json] [--out f]
 *             [--no-local-first] [--ledger <账本路径>]
 * 只读：聚合账本 + 打印评分表与前后链对比；不发网络请求、不写任何文件（--out 除外）。
 * --ledger 供自测/演练指向隔离账本（审查 D 条：显式注入 ms 构造场景，不污染真账本）。 */
async function cmdStrategy() {
  const days = Number(flag('--days', STRATEGY_DAYS)) || STRATEGY_DAYS;
  const task = flag('--task', null);
  if (task && !ROUTES[task]) {
    console.error(`未知任务类型：${task}（可用：${Object.keys(ROUTES).join(' / ')}）`); process.exit(2);
  }
  const ledger = flag('--ledger', null);
  const pools = task ? { [task]: ROUTES[task] } : { ...ROUTES, fanout: FANOUT_CHANNELS };
  const snapshot = { generatedAt: new Date().toISOString(), windowDays: days, localFirst: !has('--no-local-first'), pools: {} };
  for (const [name, chain] of Object.entries(pools)) {
    // fanout 是"全派"语义（所有模型都调动一遍），没有本地优先概念 → 观测时不套守门，忠实反映纯分数序
    const { chain: after, report } = rankChain(chain, { localFirst: name === 'fanout' ? false : snapshot.localFirst, days, file: ledger });
    snapshot.pools[name] = { before: chain, after, report };
    if (has('--json')) continue;
    console.log(`\n[${name}] 窗口 ${days} 天 · 样本<${MIN_SAMPLES} 记中性分 · 衰减半衰期${HALF_LIFE_DAYS}天 · ⛔=熔断沉底/全失败沉底`);
    console.log('  ' + '#'.padStart(3) + 'score'.padStart(8) + 'okRate'.padStart(13) + 'avgMs'.padStart(9) + 'tier'.padStart(5) + '  channel');
    report.forEach((r, i) => {
      console.log('  ' + String(i + 1).padStart(3) + r.score.toFixed(3).padStart(8)
        + `${(r.okRate * 100).toFixed(0)}%(n=${r.samples})`.padStart(13)
        + (r.avgMs == null ? '—'.padStart(8) : `${r.avgMs}ms`.padStart(9))
        + String(r.tier).padStart(5)
        + (r.broken || r.allFailed ? ' ⛔ ' : '   ') + r.channel);
    });
    const same = chain.length === after.length && chain.every((ch, i) => ch === after[i]);
    console.log(`  → ${same ? '与静态链一致（历史不足以改变顺序）' : '顺序已按历史表现调整'}`);
  }
  const text = JSON.stringify(snapshot, null, 2);
  const out = flag('--out', null);
  if (out) { writeFileSync(out, text); console.error(`已写入 ${out}`); }
  else console.log(text);
}

async function callChannel(channel, prompt, opts) {
  const { provider, model } = splitChannel(channel);
  const cfg = PROVIDERS[provider];
  if (!cfg) throw new Error(`未知 provider: ${provider}`);
  // 白名单强约束：某些 provider 只允许调用指定模型（用户显式指令，避免误调收费/未授权模型）
  if (cfg.allowModels && !cfg.allowModels.includes(model)) {
    throw new Error(`${provider} 只允许调用：${cfg.allowModels.join(' / ')}（已配置白名单，当前传入 ${model}）`);
  }
  // max_tokens 钳制：个别模型有硬上限，超了直接 400（实测 zhipu:glm-4v-flash 上限 1024）
  const cap = MAX_TOKENS_CAP[channel];
  const eff = cap && opts.maxTokens > cap ? { ...opts, maxTokens: cap } : opts;

  const t0 = Date.now();
  try {
    const res = cfg.kind === 'ollama'
      ? await callOllama(model, prompt, eff)
      : await callOpenAI(provider, model, prompt, eff);
    const ms = Date.now() - t0;
    logUsage({ at: new Date().toISOString(), channel, ok: true, ms, chars: (res.text ?? '').length, maxTokens: eff.maxTokens });
    return { ...res, channel, elapsedMs: ms };
  } catch (e) {
    logUsage({ at: new Date().toISOString(), channel, ok: false, ms: Date.now() - t0, error: String(e.message).slice(0, 120) });
    throw e;
  }
}

/* ────────────── 降级执行 ────────────── */
async function runChain(chain, prompt, opts) {
  const attempts = [];
  for (const channel of chain) {
    // ① 熔断：冷却中 / 已死的通道直接跳过 —— 不浪费一次调用，也不浪费时间
    if (shouldSkip(channel)) {
      const st = healthAll()[channel];
      attempts.push({ channel, ok: false, skipped: true, reason: st?.reason ?? '冷却中' });
      process.stderr.write(`  ⏭️  ${channel} 冷却中，跳过（${st?.reason ?? ''}）\n`);
      continue;
    }
    try {
      const res = await callChannel(channel, prompt, opts);
      attempts.push({ channel, ok: true, ms: res.elapsedMs });
      onSuccess(channel, res.elapsedMs);              // ② 成功 → 健康表恢复（含"冷却到期试探成功"）
      return { ok: true, ...res, attempts };
    } catch (e) {
      // ③ 失败 → 记健康表：402/429 冷却并指数退避；401/403/404 永久禁用
      const m = e.message.match(/HTTP (\d{3})/);
      const kind = m ? Number(m[1]) : (/(timeout|abort|ECONN|fetch failed)/i.test(e.message) ? 'timeout' : 'error');
      const entry = onFailure(channel, kind, e.message);
      attempts.push({ channel, ok: false, error: e.message, health: entry.state, cooldownMs: entry.cooldownMs });
      process.stderr.write(`  ⚠️ ${channel} 失败：${e.message.slice(0, 90)} → 降级（${entry.reason}）\n`);
    }
  }
  return { ok: false, attempts };
}

/* ────────────── 校验：产出是否可用 ────────────── */
function verify(text, task) {
  if (task === 'extract' || task === 'classify') {
    const m = text.match(/```(?:json)?\s*([\s\S]*?)```/) ?? text.match(/(\{[\s\S]*\}|\[[\s\S]*\])/);
    const body = (m ? m[1] : text).trim();
    try { JSON.parse(body); return { ok: true, note: 'JSON 可解析' }; }
    catch (e) { return { ok: false, note: `JSON 解析失败: ${e.message}` }; }
  }
  if (text.trim().length === 0) return { ok: false, note: '空输出' };
  return { ok: true, note: `非空（${text.length} 字符）` };
}

/* ────────────── CLI ────────────── */
function flag(name, def) {
  const i = process.argv.indexOf(name);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : def;
}
function has(name) { return process.argv.includes(name); }

async function cmdList() {
  const debug = has('--debug-creds');
  console.log('通道（凭据 = 环境变量优先，凭据文件回退；本地无需 key。--debug-creds 显示来源）：');
  for (const [name, cfg] of Object.entries(PROVIDERS)) {
    let k = cfg.keyEnv ? (CREDS[cfg.keyEnv] ? '✅有key' : '❌无key') : '本地';
    if (debug && cfg.keyEnv && CREDS[cfg.keyEnv]) k += `(${CRED_SOURCE[cfg.keyEnv] ?? '?'})`;
    console.log(`  ${name.padEnd(18)} ${cfg.kind.padEnd(8)} ${k.padEnd(10)} ${cfg.baseURL}`);
  }
  const hint = describeMissingCreds();
  if (hint) console.log(`\n${hint}`);
  console.log('\n路由表（左→右 = 降级顺序，本地优先）：');
  for (const [task, chain] of Object.entries(ROUTES)) {
    console.log(`  ${task.padEnd(14)} ${chain.join('  →  ')}`);
  }
}

async function cmdProbe() {
  // --models a:b,c:d → 定向探测指定通道（跳过默认遍历），用于试新模型名/免费档
  const only = flag('--models', null);
  const channels = only
    ? only.split(',').map((s) => s.trim()).filter(Boolean)
    : ['ollama:qwen2.5:7b-instruct', 'ollama:qwen2.5-coder:7b', 'ollama:deepseek-r1:7b'];
  const skipped = [];
  if (!only) {
    // 云端通道自动遍历：有 key 才探测（缺 key 的通道在降级时会被瞬时跳过，没必要发请求）
    for (const [name, cfg] of Object.entries(PROVIDERS)) {
      if (cfg.local) continue;
      if (!cfg.probeModel) { skipped.push(`${name}(无 probeModel)`); continue; }
      if (cfg.keyEnv && !CREDS[cfg.keyEnv]) { skipped.push(`${name}(缺 ${cfg.keyEnv})`); continue; }
      channels.push(`${name}:${cfg.probeModel}`);
    }
  }
  const timeoutMs = Number(flag('--timeout', 120)) * 1000;
  const concurrency = Math.max(1, Number(flag('--concurrency', 6)));
  const maxTokens = Number(flag('--tokens', 16));
  console.log(`探测 ${channels.length} 个通道（并发 ${concurrency} · 单通道超时 ${timeoutMs / 1000}s · tokens ${maxTokens}）…`);
  if (skipped.length) console.log(`  ⏭️  跳过：${skipped.join('、')}`);
  console.log('');
  const tAll = Date.now();
  const lines = [];
  for (let i = 0; i < channels.length; i += concurrency) {
    const part = await Promise.all(channels.slice(i, i + concurrency).map(async (ch) => {
      const s = Date.now();
      try {
        const r = await callChannel(ch, '只回复两个字：在线', {
          task: 'chat', maxTokens, temperature: 0, timeoutMs,
        });
        return `  ✅ ${ch.padEnd(52)} ${String(Date.now() - s).padStart(6)}ms  「${(r.text ?? '').trim().slice(0, 24)}」`;
      } catch (e) {
        return `  ❌ ${ch.padEnd(52)} ${String(Date.now() - s).padStart(6)}ms  ${e.message}`;
      }
    }));
    lines.push(...part);
  }
  lines.forEach((l) => console.log(l));
  console.log(`\n探测完成：总耗时 ${((Date.now() - tAll) / 1000).toFixed(1)}s`);
}

async function cmdRun(task) {
  // --model <通道> 覆盖路由链：跳过"本地优先"，直接把长材料交给指定云端
  // （本地 7B 吃不下 ≥20k tokens 的材料：实测 64KB 材料它照样"接活"，但产出是重审而非汇总）
  const override = flag('--model', null);
  // 非法 task 先行拦截（审查 A 条修正：策略层 rankChain 假设链是数组，ROUTES[task] 为 undefined
  // 会栈崩 TypeError）——保留 v1 的优雅报错；显式 --model 时不校验 task（用户指定优先，维持原行为）
  if (!override && !ROUTES[task]) {
    console.error(`未知任务类型：${task}\n可用：${Object.keys(ROUTES).join(' / ')}`); process.exit(2);
  }
  // 策略层重排：按「历史成功率×延迟×成本」给静态链排序；显式 --model 是最高优先策略，不重排
  const ranked = override ? null : rankChain(ROUTES[task], { localFirst: !has('--no-local-first') });
  const chain = override ? [override] : ranked.chain;

  let material = flag('--text', null);
  const inFile = flag('--in', null);
  if (!material && inFile) material = inFile === '-' ? readFileSync(0, 'utf8') : readFileSync(inFile, 'utf8');
  if (!material) { console.error('缺少材料：用 --text "…" 或 --in <文件|->'); process.exit(2); }

  const instruction = flag('--instruction', defaultInstruction(task));
  const prompt = instruction + '\n\n=== 材料 ===\n' + material;

  const opts = {
    task,
    maxTokens: Number(flag('--tokens', task === 'reason' ? 1600 : 1200)),
    temperature: Number(flag('--temp', 0.2)),
    timeoutMs: Number(flag('--timeout', 300)) * 1000,
  };

  console.error(`路由 ${task}：${chain.join(' → ')}`);
  if (ranked && has('--explain')) {
    process.stderr.write(`  策略层评分明细（权重 ok ${SCORE_WEIGHTS.ok} / 延迟 ${SCORE_WEIGHTS.latency} / 成本 ${SCORE_WEIGHTS.cost}，时间衰减半衰期 ${HALF_LIFE_DAYS} 天）：\n`);
    ranked.report.forEach((r, i) => process.stderr.write(`  ${i + 1}. ${r.reason}  ${r.channel}\n`));
  }
  const res = await runChain(chain, prompt, opts);
  if (!res.ok) {
    console.error('❌ 全部通道失败：');
    res.attempts.forEach((a) => console.error(`   ${a.channel}: ${a.error}`));
    process.exit(1);
  }

  const payload = { task, channel: res.channel, elapsedMs: res.elapsedMs, attempts: res.attempts, output: res.text };
  if (res.embedding) payload.embeddingDim = res.embedding.length;

  if (!has('--no-verify')) {
    const v = verify(res.text, task);
    payload.verify = v;
    console.error(`校验：${v.ok ? '✅' : '⚠️'} ${v.note}`);
  }

  const out = flag('--out', null);
  const text = JSON.stringify(payload, null, 2);
  if (out) { writeFileSync(out, text); console.error(`已写入 ${out}`); }
  else console.log(text);

  if (payload.verify && !payload.verify.ok) process.exit(3);   // 校验失败 → 非零退出，便于上层发现
}

function defaultInstruction(task) {
  switch (task) {
    case 'summarize': return '把下面的内容压缩成中文要点（保留关键数字与结论，不超过 12 行）：';
    case 'extract': return '从下面内容里抽取结构化信息，只输出 JSON，不要解释：';
    case 'classify': return '把下面条目分类打标，只输出 JSON 数组，每项 {item, label}：';
    case 'review-code': return '审查下面的代码，找出会导致运行期出错的 bug（如状态不平衡、硬编码色、越界），用中文逐条列出并给修复建议：';
    case 'reason': return '请一步步推理并给出结论（中文）：';
    case 'write-code': return '按下面的需求写代码，只输出代码与必要注释：';
    default: return '请处理下面的内容：';
  }
}

async function cmdAsk(question) {
  const ch = flag('--model', 'zhipu:glm-5.3-flash');
  // 走 runChain（单元素链）→ 自动享受熔断：冷却中的通道直接跳过，失败写健康表
  const res = await runChain([ch], question, {
    task: 'chat', maxTokens: Number(flag('--tokens', 500)), temperature: 0.2,
    timeoutMs: Number(flag('--timeout', 180)) * 1000,
  });
  if (!res.ok) {
    const last = res.attempts[res.attempts.length - 1] ?? {};
    console.error(`❌ ${ch} 调用失败：${last.error ?? last.reason ?? '未知原因'}`);
    process.exit(3);
  }
  console.log(JSON.stringify({ channel: ch, elapsedMs: res.elapsedMs, output: res.text, attempts: res.attempts }, null, 2));
}

/* ────────────── 全通道扇出（用户 2026-10 指令）──────────────
 * 用户要求：「每次工作所有的模型都可以调动一遍，把工作分批分派给他们之后再进行归档，
 *            如果实在做不了的部分，你自己再做」。
 * 与 runChain 的区别：
 *   runChain = **串行降级**（一个失败才换下一个，只取一个结果）——保底用；
 *   fanout   = **并发全派**（每个通道各干一份，全部归档）——默认姿势用，三种场景：
 *     ① 全通道体检（谁挂着、谁拥堵、谁恢复）
 *     ② 同一份材料多模型交叉验证（避免偏用"顺手"的那几个）
 *     ③ 一批小任务分给不同模型（轮换；小数据给 glm-4-flash / qwen2.5:3b 更快更省）
 * 硬边界：沙箱禁止脚本 spawn 子进程 → fanout 只适合"文本进、文本出"的活；本机命令只能主模型跑。
 */
const FANOUT_CHANNELS = [
  // ── 本地（0 元，唯一无限；小数据优先 3b，它比 7b 快一倍）──
  'ollama:qwen2.5:3b',
  'ollama:qwen2.5:7b-instruct',
  'ollama:qwen2.5-coder:7b',
  'ollama:deepseek-r1:7b',
  // ── 智谱：glm-4-flash/4v-flash/4-air 永久免费（不在 /models 列表里但实测能调）；
  //    glm-5.2 每日 300 万 tokens；glm-5.3-flash / flashx = 用户资源包（付费，放后面）──
  'zhipu:glm-4-flash',
  'zhipu:glm-4v-flash',
  'zhipu:glm-4-air',
  'zhipu:glm-4.5-flash',
  'zhipu:glm-5.2',
  'zhipu:glm-5.3-flash',
  'zhipu:glm-5.3-flashx',
  // ── 魔搭：每日 2000 次（UTC+8 重置，单模型≤500 次）。/models 列 35 个，实测可用如下 9 个 ──
  'modelscope:deepseek-ai/DeepSeek-V4-Flash-0731',
  'modelscope:deepseek-ai/DeepSeek-V4-Pro',
  'modelscope:Qwen/Qwen3.8-Flash-Next',
  'modelscope:Qwen/Qwen3.5-27B',
  'modelscope:stepfun-ai/Step-3.7-Flash',
  'modelscope:ZhipuAI/GLM-5.2',
  'modelscope:nex-agi/Nex-N2.5-Pro',
  'modelscope:meituan-longcat/LongCat-Flash-Lite',
  'modelscope:Shanghai_AI_Laboratory/Intern-S1-mini',
  // ── 火山方舟：每日 token 额度（用户口径 50 万）。/models 列 135 个，但**只有已开通的能调**，
  //    实测 404 的：kimi-k2-250711 / doubao-seed-2-0-pro-260215 / doubao-seed-code-preview-251028 / doubao-seed-1-6-flash-250828 ──
  'volces:doubao-seed-2-1-pro-260915',
  'volces:doubao-seed-2-1-turbo-260628',
  'volces:doubao-seed-2-1-lite-260915',
  'volces:deepseek-v4-flash-ga-260731',
  'volces:deepseek-v4-pro-ga-260813',
  'volces:glm-5-3-flash-260828',
  // ── 商汤：额度每周重置。⚠️ 有 TPM/RPM 限速（kimi-k3 / deepseek-v4-pro 首测即 429）→
  //    派发时**不要并发轰炸这一家**，见 tools/QUOTA-LIMITS.md ──
  'sensenova:sensenova-6.8-flash-lite',
  'sensenova:deepseek-v4-flash',
  'sensenova:glm-5.2',
  // ── Kimi：付费体验金，只有 2 个模型，用完即止（用户要求：不能用时通知他）──
  'moonshot:kimi-k2.6',
  'moonshot:kimi-k2.7-code',
  // ── OpenRouter：免费模型 **50 次/天**（官方计数器 free_model_daily_requests，2026-10 实测 limit=50）
  //    ⚠️ 额度最小的一家 → 不要每轮扇出都全派，按任务挑 1-2 个 ──
  'openrouter:nvidia/nemotron-3.5-lightning:free',      // 3.2s，1M 上下文
  'openrouter:nvidia/nemotron-3-ultra-550b-a55b:free',  // 1.0s，1M 上下文
  'openrouter:nvidia/nemotron-3-super-120b-a12b:free',  // 28s，长上下文
  'openrouter:inclusionai/ling-3.0-flash-sante:free',   // 1.2s
  'openrouter:dots-studio/dots-3-note-preview:free',    // 2.0s，512k
  'openrouter:cohere/north-mini-code:free',             // 1.7s，代码专用
  'openrouter:liquid/lfm-2.5-2.6b:free',                // 2.9s，小模型
  'openrouter:nvidia/nemotron-3-nano-omni-30b-a3b-reasoning:free', // 推理型，token 要给够
  // ── NVIDIA NIM：免费档 **40 RPM / 10000 次/天**（额度最大的一家）──
  //    2026-10 全量实测 81 个目录模型 → **12 个可用 / ~50 个 404「Not found for account」/ 9 个 60s 永久超时**。
  //    结论：NVIDIA 是「账号级开通制」——目录列出来 ≠ 你有权限，每个都要单独试 ──
  'nvidia:openai/gpt-oss-20b',                            // 2.1s
  'nvidia:poolside/laguna-xs-2.1',                        // 0.68s（该家最快）
  'nvidia:meta/muse-glimmer-30b',                         // 7.7s
  'nvidia:meta/llama-3.2-11b-vision-instruct',            // 0.55s（视觉）
  'nvidia:nvidia/nemotron-3-nano-omni-30b-a3b-reasoning', // 2.1s
  'nvidia:nvidia/ising-calibration-1.5-31b',              // 2.2s（摘要型）
  'nvidia:nvidia/nemotron-3-super-120b-a12b',             // 3.8s（⚠️ 偶发 503）
  'nvidia:nvidia/nemotron-3-ultra-550b-a55b',             // 1.3s（⚠️ 偶发 503）
  // NVIDIA 功能专用型（不进通用扇出，需要时用 --only 单独调）：
  //   nvidia/riva-translate-4b-instruct-v1.1 / v2（翻译）、nvidia/nemotron-parse-2.0（文档解析/OCR）、
  //   nvidia/nemotron-3.5-content-safety + nvidia/llama-3.1-nemotron-safety-guard-8b-v3（安全审核）
  // ⛔ NVIDIA 永久不可用（勿加，9 个 60s 超时）：deepseek-ai/deepseek-v4.1-flash、google/gemma-4-31b-it、
  //    meta/llama-3.2-90b-vision-instruct、meta/llama-guard-4-12b、moonshotai/kimi-k3、
  //    nvidia/llama-3.1-nemoguard-8b-content-safety、nvidia/nemotron-3.5-lightning-30b-a3b、
  //    z-ai/glm-5.3、z-ai/glm-5.3-flash
  // ⛔ OpenRouter 实测不可用（勿加）：
  //    thinkingmachines/inkling:free + inkling-small:free → 403「only available on agentic harnesses」
  //    qwen/qwen3.8-27b:free、poolside/laguna-s-2.1:free、laguna-xs-2.1:free、google/gemma-4-*:free → 429/400 上游限流
  // ⛔ 不入扇出：deepseek-official(=主会话自己)、bge-m3(嵌入)、siliconflow/bailian(已弃用)
  // ⚠️ 实测不可用，不要加：modelscope:MiniMax/MiniMax-M3(400 无供应商)、
  //    sensenova:u1-fast / u1.5-lite(404)、zhipu:glm-4.6-flash(403 无权)
  // ⚠️ 拥堵待恢复：zhipu:glm-4.7-flash(429)
];

async function cmdFanout() {
  const text = flag('--text', null);
  const inFile = flag('--in', null);
  let material = text;
  if (!material && inFile) material = inFile === '-' ? readFileSync(0, 'utf8') : readFileSync(inFile, 'utf8');
  if (!material) { console.error('缺少材料：--text "…" 或 --in <文件|->'); process.exit(2); }

  const task = flag('--task', 'summarize');
  const instruction = flag('--instruction', defaultInstruction(task));
  const prompt = instruction + '\n\n=== 材料 ===\n' + material;
  const maxTokens = Number(flag('--tokens', 900));
  const concurrency = Number(flag('--concurrency', DEFAULT_CONCURRENCY)) || DEFAULT_CONCURRENCY;
  const timeoutSec = Number(flag('--timeout', 180)) || 180;
  const only = flag('--only', null);
  const channels = only ? only.split(',').map((s) => s.trim()).filter(Boolean) : FANOUT_CHANNELS;

  // 按 provider 分组：组内受该家的并发上限约束（本地/商汤/Kimi=1，火山=2…），组间并行
  const groups = new Map();
  for (const ch of channels) {
    const p = ch.split(':')[0];
    if (!groups.has(p)) groups.set(p, []);
    groups.get(p).push(ch);
  }
  const plan = [...groups.entries()]
    .map(([p, list]) => `${p}×${list.length}(${Math.max(1, Math.min(PROVIDER_CONCURRENCY[p] ?? concurrency, list.length))})`)
    .join(' · ');
  console.log(`扇出 ${channels.length} 个通道 / ${groups.size} 家 · 任务 ${task} · 材料 ${material.length} 字符`);
  console.log(`  并发计划：${plan}`);

  const t0 = Date.now();
  const runOne = async (ch) => {
    const s = Date.now();
    try {
      const r = await callChannel(ch, prompt, { task, maxTokens, temperature: 0.2, timeoutMs: timeoutSec * 1000 });
      return { channel: ch, ok: true, ms: Date.now() - s, chars: (r.text ?? '').length, output: r.text ?? '' };
    } catch (e) {
      return { channel: ch, ok: false, ms: Date.now() - s, error: e.message };
    }
  };
  const perGroup = await Promise.all([...groups.entries()].map(async ([p, list]) => {
    const limit = Math.max(1, Math.min(PROVIDER_CONCURRENCY[p] ?? concurrency, list.length));
    const out = [];
    for (let i = 0; i < list.length; i += limit) {
      out.push(...await Promise.all(list.slice(i, i + limit).map(runOne)));
    }
    return out;
  }));
  const results = perGroup.flat();
  const okN = results.filter((r) => r.ok).length;
  console.log(`\n✅ ${okN} 成功 / ❌ ${results.length - okN} 失败 · 总耗时 ${((Date.now() - t0) / 1000).toFixed(1)}s\n`);
  for (const r of results) {
    console.log(r.ok
      ? `  ✅ ${r.channel.padEnd(48)} ${String(r.ms).padStart(6)}ms  ${String(r.chars).padStart(5)} 字符`
      : `  ❌ ${r.channel.padEnd(48)} ${String(r.ms).padStart(6)}ms  ${r.error}`);
  }
  const dir = ARCHIVE_DIR;
  mkdirSync(dir, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const rnd = Math.random().toString(36).slice(2, 8);   // 同一毫秒内两次运行也不会互相覆盖
  const file = join(dir, `fanout-${stamp}-${rnd}.json`);
  writeFileSync(file, JSON.stringify({ at: new Date().toISOString(), task, materialChars: material.length, totalMs: Date.now() - t0, results }, null, 2), 'utf8');
  console.log(`\n📦 已归档 ${results.length} 份结果 → ${file}`);
}

/* ────────────── 额度账本查询 ────────────── */
async function cmdUsage() {
  const days = Number(flag('--days', 1)) || 1;
  const since = Date.now() - days * 86400_000;
  const file = join(ARCHIVE_DIR, 'usage.jsonl');
  if (!existsSync(file)) { console.log(`还没有账本（${join(ARCHIVE_DIR, 'usage.jsonl')}）——跑一次 fanout / run / ask 就会自动开始记`); return; }
  const rows = readFileSync(file, 'utf8').split('\n').filter(Boolean)
    .map((l) => { try { return JSON.parse(l); } catch { return null; } })
    .filter(Boolean)
    .filter((r) => new Date(r.at).getTime() >= since);

  const byProv = new Map();
  for (const r of rows) {
    const p = String(r.channel).split(':')[0];
    const e = byProv.get(p) ?? { calls: 0, ok: 0, chars: 0, ms: 0, fails: [] };
    e.calls++;
    if (r.ok) { e.ok++; e.chars += r.chars ?? 0; e.ms += r.ms ?? 0; }
    else if (e.fails.length < 3) e.fails.push(`${r.channel}: ${String(r.error ?? '').slice(0, 40)}`);
    byProv.set(p, e);
  }
  console.log(`额度账本 · 最近 ${days} 天 · 共 ${rows.length} 次调用\n`);
  console.log('  ' + 'provider'.padEnd(12) + 'calls'.padStart(6) + '  ok'.padStart(5) + '  周期上限'.padEnd(20) + '用量占比'.padStart(9) + '  平均延迟');
  for (const [p, e] of [...byProv.entries()].sort((a, b) => b[1].calls - a[1].calls)) {
    const q = PERIOD_QUOTA[p];
    const lim = q?.limit ?? null;
    const limStr = lim === Infinity ? '无限' : lim == null ? (q?.unit ?? '未明确') : `${lim} ${q.unit}`;
    const pct = lim && lim !== Infinity ? `${((e.calls / lim) * 100).toFixed(1)}%`.padStart(8) : '       —';
    const avg = e.ok ? Math.round(e.ms / e.ok) + 'ms' : '—';
    console.log('  ' + p.padEnd(12) + String(e.calls).padStart(6) + String(e.ok).padStart(5) + '  ' + limStr.padEnd(18) + pct + '  ' + avg);
  }
  const failing = [...byProv.entries()].filter(([, e]) => e.fails.length);
  if (failing.length) {
    console.log('\n  近期失败样例：');
    for (const [, e] of failing) for (const f of e.fails) console.log('    · ' + f);
  }
}

/* ────────────── 派发闸门统计（子代理调用的观测入口，2026-10）──────────────
 * 背景：子代理（workflow + provider 覆盖）的 LLM 调用走 DSH 直连，不经过 model-hub → 不进 usage.jsonl，
 *       额度账本存在观测盲区；而闸门插件（plugins/gate-v9）记录了每一次派发（时间/会话/工具）。
 * 数据源：<archive>/dispatch-stats.jsonl，每行一条 {at, agent, tool, kind}（append-only）：
 *   kind ∈ dispatch=派发（workflow/task_board_run/含 model-hub 的 pwsh）· selfdo=自办（pwsh/write/edit）
 *          · research=直查资料（web_search 等检索工具）· blocked=被拦（guard 在工具调用层拒绝的调用，v9 新增）。
 *          把它接进来 = 子代理额度消耗的旁证入口。
 */
const GATE_FILE = 'dispatch-stats.jsonl';
const GATE_KINDS = { dispatch: '派发', selfdo: '自办', research: '直查资料', blocked: '被拦' };

/* 读闸门流水：--days N 只留最近 N 天（0 = 全部）；坏行跳过、读不到返回 null（调用方优雅提示） */
function loadGateRows(days) {
  const file = join(ARCHIVE_DIR, GATE_FILE);
  if (!existsSync(file)) return null;
  const since = days > 0 ? Date.now() - days * 86400_000 : 0;
  try {
    const rows = [];
    for (const line of readFileSync(file, 'utf8').split('\n')) {
      if (!line) continue;
      let r; try { r = JSON.parse(line); } catch { continue; }   // 坏行跳过，与 cmdUsage 同款
      const ts = new Date(r.at).getTime();
      if (since && (!Number.isFinite(ts) || ts < since)) continue;
      rows.push(r);
    }
    return rows;
  } catch { return null; }                                     // 读不到 → 当没有
}

/* 派发闸门总览：node model-hub.mjs gate [--days N] [--json]
 * 只读：纯聚合打印，不派发不写文件；派发率 = 派发 / 总动作（与闸门插件回合判词同口径：有派发=合规）。 */
async function cmdGate() {
  const days = Number(flag('--days', 0)) || 0;
  const rows = loadGateRows(days);
  if (rows == null) {
    console.log(`还没有闸门数据（${join(ARCHIVE_DIR, GATE_FILE)}）——装上闸门插件（记录派发的 dispatch-stats）并派发过一次就会自动开始记`);
    return;
  }
  const byKind = new Map(), byTool = new Map(), byAgent = new Map();
  for (const r of rows) {
    const kind = GATE_KINDS[r.kind] ? r.kind : 'other';        // 未知 kind 兜底成 other，不崩
    byKind.set(kind, (byKind.get(kind) ?? 0) + 1);
    const tool = String(r.tool ?? 'unknown');
    byTool.set(tool, (byTool.get(tool) ?? 0) + 1);
    const agent = String(r.agent ?? 'unknown');
    byAgent.set(agent, (byAgent.get(agent) ?? 0) + 1);
  }
  const disp = byKind.get('dispatch') ?? 0, self = byKind.get('selfdo') ?? 0,
        research = byKind.get('research') ?? 0, blocked = byKind.get('blocked') ?? 0;
  // ⚠️ 口径修正（v9 加入 blocked 后）：派发率分母 = dispatch + selfdo + research，**不含 blocked（被拦）**。
  // 被拦调用在工具调用层就被 guard 直接拒绝，从未真正产生工作量；把它算进分母会稀释派发率口径。
  const workload = disp + self + research;
  const rate = workload ? Math.round((disp / workload) * 100) : 0;   // 空窗口除零保护
  const conclusion = `派发 ${disp} 次 · 自办 ${self} 次 · 直查资料 ${research} 次 · 被拦 ${blocked} 次 —— 派发率 ${rate}%`;
  // kind 展示顺序固定：dispatch → selfdo → research → blocked → other（数量降序会让字段随数据波动乱跳）
  const KIND_ORDER = ['dispatch', 'selfdo', 'research', 'blocked', 'other'];
  const kindEntries = KIND_ORDER.filter((k) => byKind.has(k)).map((k) => [k, byKind.get(k)]);
  if (has('--json')) {
    const obj = (m) => Object.fromEntries([...m.entries()].sort((x, y) => y[1] - x[1]));
    console.log(JSON.stringify({
      file: join(ARCHIVE_DIR, GATE_FILE), windowDays: days || null, total: rows.length,
      kinds: Object.fromEntries(kindEntries), dispatchRate: `${rate}%`, byTool: obj(byTool), byAgent: obj(byAgent), conclusion,
    }, null, 2));
    return;
  }
  console.log(`派发闸门统计 · ${days > 0 ? `最近 ${days} 天` : '全部时间'} · 共 ${rows.length} 条（${join(ARCHIVE_DIR, GATE_FILE)}）\n`);
  console.log(`  ${conclusion}`);
  console.log('\n按 kind：');
  for (const [k, n] of kindEntries)
    console.log(`  ${k.padEnd(10)} ${(GATE_KINDS[k] ?? '未知').padEnd(6)} ${String(n).padStart(5)}  ${((n / rows.length) * 100).toFixed(1)}%`);
  console.log('\n按工具：');
  for (const [t, n] of [...byTool.entries()].sort((x, y) => y[1] - x[1]))
    console.log(`  ${t.padEnd(16)} ${String(n).padStart(5)}`);
  console.log('\n按会话（agent）：');
  for (const [a, n] of [...byAgent.entries()].sort((x, y) => y[1] - x[1])) {
    const label = a.length > 34 ? a.slice(0, 31) + '…' : a;    // 会话 id 太长，展示截断（--json 保留全量）
    console.log(`  ${label.padEnd(36)} ${String(n).padStart(5)}`);
  }
}

/* ────────────── 入口 ────────────── */
const cmd = process.argv[2];
const arg = process.argv[3];
if (cmd === 'list') await cmdList();
else if (cmd === 'probe') await cmdProbe();
else if (cmd === 'run') await cmdRun(arg);
else if (cmd === 'ask') await cmdAsk(arg);
else if (cmd === 'fanout') await cmdFanout();
else if (cmd === 'usage') await cmdUsage();
else if (cmd === 'gate') await cmdGate();
else if (cmd === 'strategy') await cmdStrategy();
else {
  console.log(`模型中枢 · 多模型集成工作流引擎

  node model-hub.mjs list                         列出通道与路由表
  node model-hub.mjs probe                        探测所有通道可用性（--models a:b,c:d 定向试 · --timeout 秒 · --concurrency N）
  node model-hub.mjs fanout --in <文件|->         全通道并发派发 + 归档（默认姿势：所有模型都调动一遍）
  node model-hub.mjs fanout --text "材料" --task extract [--only a:b,c:d] [--tokens N]
  node model-hub.mjs run <task> --in <文件|->     按任务类型走路由（本地优先 + 串行降级，保底用）
  node model-hub.mjs run <task> --in f --model zhipu:glm-4-air   跳过本地直接指定云端（长材料用）
  node model-hub.mjs ask "问题" [--model zhipu:glm-4-flash]
  node model-hub.mjs usage [--days 7]             额度账本：各家用了几次 / 占周期上限多少
  node model-hub.mjs gate [--days N] [--json]     派发闸门统计：派发/自办/直查 × 工具 × 会话（子代理观测入口）
  node model-hub.mjs strategy [--task summarize] [--days 7] [--json] [--no-local-first] [--ledger f]
                                                  策略层观测台：按历史表现给通道打分排序（只读，不改任何行为）

任务类型：${Object.keys(ROUTES).join(' / ')}

选项：--tokens N  --temp 0.2  --timeout 300  --out 结果.json  --instruction "自定义指令"  --no-verify

环境变量（凭据解析顺序：环境变量 → 凭据文件 → 清晰报错）：
  ${ALL_KEY_ENVS.join(' / ')}   各云端 API key（设置即生效，无需凭据文件）
  MODELHUB_CREDENTIALS   凭据文件路径（默认 ~/.dsh/.credentials.yaml；KEY: value 每行一条）
  MODELHUB_ARCHIVE_DIR   账本/归档目录（默认脚本同目录 archive/，npm 安装建议覆盖为可写目录）
  MODEL_HEALTH_FILE      熔断健康表文件（默认 ./model-health.json）· OLLAMA_URL  Ollama 地址（默认 http://127.0.0.1:11434）`);
}
