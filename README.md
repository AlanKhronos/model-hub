# model-hub（模型中枢）

[![CI](https://github.com/AlanKhronos/model-hub/actions/workflows/ci.yml/badge.svg)](https://github.com/AlanKhronos/model-hub/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)
[![Node](https://img.shields.io/badge/node-%3E%3D20-brightgreen.svg)](https://nodejs.org)

> **"别人 clone 下来能跑吗？"—— CI 已经证明能。**
> 每次推送都在 GitHub 的**全新容器**里跑（Ubuntu + Windows × Node 20/22/24，共 7 个 job），
> **不依赖作者本机环境**（无凭据文件、无 Ollama、无任何预装）。点上方 CI 徽章可查看每次运行的完整日志。

> 📦 **npm 官方包（`@alankhronos/model-hub`）发布待定**，届时可用 `npx @alankhronos/model-hub`。当前以 GitHub 为唯一分发渠道，安装方式见下方「安装」一节。

多模型集成工作流引擎 —— **一张路由表 + 一条降级链**，把「用哪个 provider / 哪个 model / 失败了怎么办」收敛成一个 CLI：
本地 Ollama 优先、云端免费档兜底、失败自动降级、产出自动校验、用量自动记账。**零依赖**（仅 Node ≥ 20 原生能力）。

## 架构（一句话）

**静态路由表 →（可选）按历史成功率×延迟×成本重排 → 串行降级链（fanout 为并发全派）→ 熔断健康表 + JSONL 账本**，全部逻辑在 `src/model-hub.mjs` 一个文件里；`src/model-health.mjs` 提供 402/429 指数退避冷却与 401/403/404 永久禁用的熔断能力。

## 安装

> npm 官方包（`@alankhronos/model-hub`）发布待定，届时可用 `npx @alankhronos/model-hub`。当前以 GitHub 为唯一分发渠道。

```bash
# 方式一：直接用 npx 从 GitHub 跑（无需安装）
npx github:AlanKhronos/model-hub --help

# 方式二：全局安装
npm i -g github:AlanKhronos/model-hub
model-hub --help
```

## Quick Start

全局安装后可直接用 `model-hub`（未安装时把下列命令前缀换成 `npx github:AlanKhronos/model-hub`）：

```bash
model-hub list --debug-creds    # 通道与路由表，key 来自 env 还是 file
model-hub probe                 # 探测各通道可用性（有 key 才发请求）
model-hub run summarize --text "要压缩的长文本"
model-hub fanout --in material.txt --task extract   # 全通道并发派发
model-hub usage --days 7        # 额度账本：各家用了几次 / 占周期上限多少
```

本机跑通的最短路径：本地 Ollama 无需任何 key → `node src/model-hub.mjs list` / `run summarize --text "你好"`（会走本地通道）。

## 凭据：环境变量优先，凭据文件回退

解析顺序：**① 环境变量**（推荐，优先级最高）→ **② 凭据文件**（默认 `~/.dsh/.credentials.yaml`，兼容 DSH 旧用法，`MODELHUB_CREDENTIALS` 可改路径）→ **③ 都没有** → 报清晰提示并列明缺哪些变量名（不抛难懂堆栈）。

### 需要设置的环境变量

| 环境变量 | 服务商 | 说明 |
|---|---|---|
| `OLLAMA_URL` | 本地 Ollama | 可选，默认 `http://127.0.0.1:11434` |
| `ZHIPU_API_KEY` | 智谱 | 免费档 `glm-4-flash` 等 |
| `MODELSCOPE_API_KEY` | 魔搭 ModelScope | 每日 2000 次 |
| `VOLCENGINE_API_KEY` | 火山方舟 | 每日 token 额度 |
| `MOONSHOTAI_CN_API_KEY` | Kimi 月之暗面 | 体验金 |
| `SENSENOVA_API_KEY` | 商汤日日新 | 每周重置 |
| `OPENROUTER_API_KEY` | OpenRouter | 免费模型 50 次/天 |
| `NVIDIA_API_KEY` | NVIDIA NIM | 10000 次/天 |
| `GROQ_API_KEY` | Groq | 免费 1000 RPD |
| `DEEPSEEK_API_KEY` | DeepSeek 官方 | 付费 |
| `CF_API_TOKEN` + `CF_ACCOUNT_ID` | Cloudflare | baseURL 占位符需要 |

辅助环境变量：

| 变量 | 作用 | 默认 |
|---|---|---|
| `MODELHUB_CREDENTIALS` | 凭据文件路径（测试隔离 / 自定义位置用） | `~/.dsh/.credentials.yaml` |
| `MODELHUB_ARCHIVE_DIR` | 账本 / fanout 归档目录（npm 安装建议覆盖为可写目录） | 脚本同目录 `archive/` |
| `MODEL_HEALTH_FILE` | 熔断健康表文件路径 | `./model-health.json`（运行目录） |

凭据文件格式（一行一个，与旧版完全一致）：

```yaml
ZHIPU_API_KEY: xxx
NVIDIA_API_KEY: yyy
```

## 子命令

| 命令 | 作用 |
|---|---|
| `list [--debug-creds]` | 列出全部通道与路由表；`--debug-creds` 显示每个 key 来自 env 还是 file |
| `fanout --in <文件|-> [--task T] [--only a:b,c:d] [--tokens N]` | **全通道并发派发**（默认姿势；一组内受各家并发上限约束），结果归档 `archive/fanout-*.json` |
| `run <task> --in/--text [--model ch] [--explain]` | 按任务类型走路由：本地优先 + 串行降级（保底），产出自动校验（JSON 任务校验可解析性） |
| `ask "问题" [--model ch]` | 单发一问（自动享受熔断：冷却中的通道直接跳过），默认 `zhipu:glm-5.3-flash` |
| `probe [--models a:b,c:d] [--tokens N]` | 探测通道可用性（有 key 才探测；`--tokens 400` 防推理型模型假空） |
| `usage [--days N]` | 额度账本：各家用了几次 / 占周期上限多少 / 平均延迟 |
| `gate [--days N] [--json]` | 派发闸门统计（数据来自 DSH 闸门插件写的 `dispatch-stats.jsonl`，**仅 DSH 场景适用**） |
| `strategy [--task T] [--days N] [--ledger f] [--json]` | 策略观测台：按历史表现给通道打分排序（只读、零网络请求） |

任务类型：`summarize / extract / classify / review-code / reason / write-code / embed`。
常用选项：`--tokens N`、`--temp`、`--timeout 秒`、`--out 结果.json`、`--instruction "…"`、`--no-verify`。

## 数据落盘（全部可重生成、可安全删除）

- `archive/usage.jsonl` —— 每次真实调用一行（`strategy` 层的评分数据源）
- `archive/fanout-*.json` —— fanout 产出归档
- `model-health.json` —— 熔断健康表（冷却跨天自动重置；`MODEL_HEALTH_FILE` 可换位置）

## 测试

```bash
npm test      # 等价于 node --test（Node 20+ 内置测试运行器，零第三方依赖）
```

覆盖 **22 项**（都在 `test/` 目录）：

| 文件 | 项数 | 覆盖内容 |
|---|---|---|
| `test/health.test.mjs` | 13 | 熔断与指数退避：429/402 基础冷却、连续失败翻倍、**上限 24h**、401/403/404 永久禁用、恢复语义、`summary` 分类、`reset`、落盘结构 |
| `test/cli.test.mjs` | 9 | CLI 黑盒（以子进程真实运行）：`--help` 的子命令与凭据说明、`list`、`usage`、`strategy --json` 的结构与评分字段、**重排不增删通道（链集合守恒）**、未知任务类型的参数校验 |

设计取舍：**不引入任何第三方测试框架**（用 Node 内置 `node:test` + `node:assert`，保住"零依赖"）；**不发网络请求** —— 只测解析、打分、熔断与持久化这些确定性逻辑。

## 已知限制（诚实声明）

- **定位是「个人多模型省钱调度器」，不是生产级 API 网关**：没有鉴权、没有请求重试队列、没有多节点高可用、没有配额中心化。
- `PROVIDERS` / `ROUTES` / `PERIOD_QUOTA` / `MAX_TOKENS_CAP` 里的模型名与额度数字**来自作者实测快照**，云端随时会变（免费档 429、NVIDIA「账号级开通制」、模型名改版等）——遇到 404/429 先对照平台当前文档更新注册表，而不是怀疑工具坏了。
- `fanout` 是「文本进 / 文本出」的纯 HTTP 派发；需要把文件路径喂给模型当工具参数的场景请自备。
- 熔断健康表默认写在**运行所在目录**，换目录运行等于各自独立的健康表（想要全局一致请统一设 `MODEL_HEALTH_FILE`）。
- `gate` 子命令依赖 DSH（DeepSeek Harness）闸门插件写出的 `dispatch-stats.jsonl`，**脱离 DSH 环境时无数据**（命令会友好提示，不报错）。
- 免费档普遍声明「prompt 可能用于训练」：**原创小说稿与私有代码只走本地或明确不训练的通道**。
- 长文本（≥20k tokens）喂本地 7B 会「重审代替汇总」——请用 `run --model <云端>` 显式指定（`--tokens` 给足，推理型模型至少 2000+）。
- 不做任何网络代理；被墙平台不可达时需要自行搭建通道（`OLLAMA_URL` / provider 的 `baseURL` 都可改）。

## 作为 MCP server 使用

本项目自带一个 [MCP](https://modelcontextprotocol.io) server（位于 [`mcp/`](mcp/)），让 Claude Desktop / Cursor / Cline 等 MCP 客户端能直接调用多模型调度能力。

**主包保持零依赖** —— MCP server 的 `@modelcontextprotocol/sdk` 依赖声明在独立的 `mcp/package.json` 里，根 `package.json` 的 `dependencies` 不受影响。

暴露 4 个 tool：`dispatch`（派发文本给多模型）、`list_channels`（通道与额度占用）、`strategy_rank`（通道排序）、`gate_stats`（行为统计）。传输方式 stdio，所有日志走 stderr。

详细配置方法见 **[mcp/README.md](mcp/README.md)**。

## License

MIT —— 详见 [LICENSE](LICENSE)。
