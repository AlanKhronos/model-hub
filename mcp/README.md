# model-hub MCP Server

把 [model-hub](../README.md) CLI 暴露为 [MCP](https://modelcontextprotocol.io) 工具，让 Claude Desktop / Cursor / Cline 等 MCP 客户端能直接调用多模型调度能力。

## 设计要点

| 项 | 选择 | 理由 |
|---|---|---|
| **传输** | stdio | 本地 CLI 工具的正确选择；HTTP+SSE 已废弃，Streamable HTTP 用于远程服务 |
| **依赖隔离** | 独立 `mcp/package.json` | 主包保持零依赖（`dependencies: {}`），`@modelcontextprotocol/sdk` 只在此声明 |
| **日志纪律** | 全走 stderr | stdio 下 stdout 留给 JSON-RPC，任何非协议文本都会让客户端解析失败 |
| **CLI 调用** | `execFile`（参数数组） | 不经 shell，杜绝命令注入 |

## 暴露的工具

| 工具 | 作用 | 映射的 CLI 命令 |
|---|---|---|
| `dispatch` | 把文本派给多模型（`mode: fanout\|run\|ask`） | `fanout --in` / `run <task> --in` / `ask "<问题>"` |
| `list_channels` | 通道与额度占用 | `usage --days 1` |
| `strategy_rank` | 某任务类型的通道排序（只读） | `strategy --task <T> --json` |
| `gate_stats` | 派发闸门行为统计（只读） | `gate --json` |

### `dispatch` 参数

| 参数 | 类型 | 必填 | 说明 |
|---|---|---|---|
| `input` | string | ✅ | 要处理的文本（fanout/run=材料，ask=问题） |
| `mode` | `fanout\|run\|ask` | — | 默认 `run` |
| `task` | enum | — | `summarize/extract/classify/review-code/reason/write-code`（ask 模式忽略） |
| `model` | string | — | 指定通道覆盖路由（仅 run/ask），如 `zhipu:glm-5.3-flash` |
| `tokens` | number | — | max tokens 上限 |

## 安装

```bash
# 在项目根目录下
cd mcp
npm install
```

这会安装 `@modelcontextprotocol/sdk`。主包不受影响（根 `package.json` 的 `dependencies` 仍为 `{}`）。

## 客户端配置

### Claude Desktop

编辑 `claude_desktop_config.json`（macOS: `~/Library/Application Support/Claude/claude_desktop_config.json`；Windows: `%APPDATA%\Claude\claude_desktop_config.json`）：

```json
{
  "mcpServers": {
    "model-hub": {
      "command": "node",
      "args": ["F:\\新工作区\\dist\\model-hub\\mcp\\server.mjs"],
      "env": {
        "ZHIPU_API_KEY": "你的key",
        "MODELSCOPE_API_KEY": "你的key",
        "OLLAMA_URL": "http://127.0.0.1:11434"
      }
    }
  }
}
```

> 把 `args` 里的路径换成你本机的实际路径。`env` 里只放你配了 key 的变量即可（本地 Ollama 无需任何 key）。

### Cursor

编辑 Cursor 设置 → MCP（或 `~/.cursor/mcp.json`）：

```json
{
  "mcpServers": {
    "model-hub": {
      "command": "node",
      "args": ["F:\\新工作区\\dist\\model-hub\\mcp\\server.mjs"],
      "env": {
        "ZHIPU_API_KEY": "你的key",
        "OLLAMA_URL": "http://127.0.0.1:11434"
      }
    }
  }
}
```

### Cline / 其他 MCP 客户端

同理：`command` = `node`，`args` = `["<绝对路径>/mcp/server.mjs"]`，`env` 放 API key。具体配置文件位置见各客户端文档。

> **用 npx（无需手写路径）**：如果已 `npm i -g github:AlanKhronos/model-hub` 并在 `mcp/` 下装了依赖，也可以写 `"command": "npx"` + `"args": ["model-hub-mcp"]`。

## 自测

```bash
cd mcp
npm install        # 装 SDK
node selftest.mjs  # 手工发 JSON-RPC 验证 stdio 协议
```

selftest 会发送 `initialize` + `tools/list` 两条请求，验证：
- stdout 只有合法 JSON-RPC 响应（无日志泄漏）
- 返回恰好 4 个工具
- 日志确实走 stderr

## 环境变量

与 CLI 完全相同，见[根 README 的凭据一节](../README.md#凭据环境变量优先凭据文件回退)。server 进程继承的全部环境变量会透传给 CLI 子进程。

关键变量：

| 变量 | 说明 |
|---|---|
| `OLLAMA_URL` | 本地 Ollama 地址（默认 `http://127.0.0.1:11434`） |
| `ZHIPU_API_KEY` | 智谱 |
| `MODELSCOPE_API_KEY` | 魔搭 |
| `VOLCENGINE_API_KEY` | 火山方舟 |
| `NVIDIA_API_KEY` / `GROQ_API_KEY` / `OPENROUTER_API_KEY` | 其他免费档 |
| `MODELHUB_CREDENTIALS` | 凭据文件路径（默认 `~/.dsh/.credentials.yaml`） |
| `MODELHUB_ARCHIVE_DIR` | 账本/归档目录（默认脚本同目录 `archive/`） |

## License

MIT —— 随主包。
