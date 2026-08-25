# Agent Jobs

一個可安裝、可重用、可續跑、以 JSON Schema 驗證的 TypeScript agent-job framework，
支援 Codex 及 Claude。每筆 input 都由全新的 native subagent context 處理；parent 只取得
canonical ID 與 opaque assignment handle，worker 再透過本地 stdio MCP 取得唯一一筆
資料並 atomic commit 結果。

命名沿用 OpenAI 舊 `spawn_agents_on_csv` 實作中的
[`AgentJob`](https://github.com/openai/codex/blob/81e89fa5af13012c8313f032a17b11b9a5170d33/codex-rs/state/src/model/agent_job.rs)
概念：一個 agent job 是一次完整 batch execution；`TASK_SPEC` 是可重用的每筆工作
定義；assignment 則是 job 中交給單一 fresh worker 的一筆 opaque lease。

## 安裝

使用者只需要 Node.js 20.6+。本階段先用本機 tarball 驗證，不 publish 到 npm：

```bash
# 在本 repository 產生 agent-jobs-0.3.0.tgz
pnpm install --frozen-lockfile
pnpm pack

# 在任意目錄初始化目前專案
npm exec --yes --package=file:/absolute/path/agent-jobs-0.3.0.tgz -- agent-jobs init

# 指定新路徑；目錄不存在時會在確認後建立
npm exec --yes --package=file:/absolute/path/agent-jobs-0.3.0.tgz -- agent-jobs init ./my-project

# CI／非互動環境
npm exec --yes --package=file:/absolute/path/agent-jobs-0.3.0.tgz -- agent-jobs init ./my-project --yes
```

`init` 預設安裝 Codex 與 Claude 所需的 skill、兩個 custom agents 及 MCP 設定。
省略 path 時使用目前目錄；`--target codex|claude` 可只安裝單一宿主，`--global`
安裝到使用者層級且不可同時指定 path。所有實際寫入預設顯示絕對路徑並以
`Proceed? [y/N]` 確認；`--dry-run` 不寫入也不詢問。

完成後重新啟動 Codex／Claude，再執行：

```bash
node .agents/skills/agent-jobs/scripts/agent-jobs.mjs doctor  # Codex project install
node .claude/skills/agent-jobs/scripts/agent-jobs.mjs doctor # Claude project install
```

MCP 是由宿主自動啟動的本地 stdio process。你不需要在 prompt 額外要求或預先手動
執行；Agent Jobs skill 會安排 worker 呼叫 MCP。若 server 無法啟動，流程會明確失敗，
不會退回直接寫入 result 檔案。

開發與建置需要 Node.js 20.19+ 或 22.12+（Vite 8 的 build-time 要求）及 pnpm。
Vite library mode 產生的單檔 ESM bundle 仍以 Node 20 為 target；使用者只需要
Node.js 20.6+，不需要安裝 pnpm、tsx 或 runtime dependencies。

## Quick start

先在已執行 `agent-jobs init` 的目標專案準備 input data 與 task spec。例如
`batch-input.json`：

```json
[
  { "id": "proposal-1", "title": "Practical TypeScript" },
  { "id": "proposal-2", "title": "Reliable Node.js Services" }
]
```

以及 `batch-task.md`：

```markdown
---
name: proposal-review
version: 1
input_schema:
  type: object
  additionalProperties: false
  required: [id, title]
  properties:
    id:
      type: string
    title:
      type: string
output_schema:
  type: object
  additionalProperties: false
  required: [decision, reason]
  properties:
    decision:
      type: string
      enum: [accept, reject]
    reason:
      type: string
---

Review the proposal title. Return a decision and a concise reason.
```

重新啟動 Codex／Claude 後送出：

```text
請處理所有 proposal，完成後整理 accept/reject 數量並說明主要理由。

INPUT_DATA: batch-input.json
TASK_SPEC: batch-task.md
ID_COLUMN_KEY: id
OUTPUT_DIR: batch-output/
MAX_CONCURRENCY: 4
COLLECT_FORMAT: json
```

`AGENTS.md` 會把含四個 required markers 的 prompt 路由到 Agent Jobs skill。markers 以外
的 prose 只供 parent 及可選的 postprocessor 使用，不會傳給 row worker。

## Prompt markers

| Marker | Required | Meaning |
| --- | --- | --- |
| `INPUT_DATA` | yes | JSON、JSONL、CSV 或 YAML input path |
| `TASK_SPEC` | yes | 含 YAML frontmatter 的 Markdown 檔案路徑 |
| `ID_COLUMN_KEY` | yes | 每筆資料的穩定唯一 ID 欄位 |
| `OUTPUT_DIR` | yes | 本次 batch 的持久化輸出目錄 |
| `RECORDS_PATH` | no | JSON Pointer；JSON/YAML 非 top-level list 時使用 |
| `MODEL` | no | 整批 row workers 的 model |
| `REASONING_EFFORT` | no | 整批 row workers 的 reasoning effort |
| `MAX_CONCURRENCY` | no | 正整數上限；實際數量仍受目前 agent slots 限制 |
| `MAX_RETRIES` | no | 每筆失敗後重試次數；預設 `1` |
| `RETRY_INVALID` | no | `true` 時 archive 既有 invalid result 再重跑 |
| `ON_ERROR` | no | `stop`（預設）或 `continue_successes` |
| `COLLECT_FORMAT` | no | `none`、`json`、`jsonl` 或 `csv`；預設 `json` |
| `POST_PROCESS_MODEL` | no | AI postprocessor model |
| `POST_PROCESS_REASONING_EFFORT` | no | AI postprocessor reasoning effort |

Model/effort precedence 是 prompt marker > spec frontmatter > parent inheritance。若某層
只選 model 而沒有 effort，該 model 使用自身預設 effort。postprocessor 可獨立 override。

## Task spec

Runnable spec 以 YAML frontmatter 保存 machine-readable contract：
`name`、`version`、可選的 `description`、`model`、`reasoning_effort`，以及必填的
`input_schema`、`output_schema`。Markdown body 是唯一的 row task instruction。

Worker 只會收到 `input_schema.properties` 宣告的欄位。`required`、空字串、null、
enum 與 additional properties 的語意都由 JSON Schema 決定。v1 支援同一 schema
內可解析的 local references；外部或無法解析的 references 會在任何 worker spawn 前
被拒絕。

## Resume 與 artifacts

```text
OUTPUT_DIR/
  runs/<safe-id>.json
  errors/<safe-id>.json
  history/invalid/...
  report.json
  .batch/jobs/...
```

`runs/<safe-id>.json` 是純 task output。只要該 path 已存在，resume 就會無條件 skip；
input、spec、prompt、model 或 effort 改變都不會使它自動失效。既有檔案若不符合目前
schema，預設保留並在 final validation 報錯；只有 `RETRY_INVALID: true` 會先 archive
再排入 queue。

ID 只接受非空 string 或 integer，並 canonicalize 為 string；float、boolean、null、
空字串與 duplicate ID 都會令整批 preflight 失敗。JSON 的超大 integer 會 losslessly
保留，不會經 JavaScript `number` 造成 ID 精度或檔名碰撞。不安全的 ID 會轉為
deterministic safe filename。

`submit_result` 會先驗證 output schema，再以 same-directory temporary file、fsync 與
atomic no-clobber publication 寫入。Worker 預設使用 `result_json` 傳遞精確 JSON 文字，
因此 64-bit 或更大的 integer 不會在 MCP JSON-RPC boundary 被轉成不精確的
JavaScript `number`；`result` object 參數仍保留給不含這類數字的相容性用法。請勿手動寫入
`runs/`，也不要讓兩個 parent 同時操作相同的 `OUTPUT_DIR`。
狀態修改使用 same-host cross-process lock；它不會因 event loop 阻塞而偷走仍在使用的
lock，owner crash 時可回收。若無法在 30 秒內取得，會回報含 owner diagnostics 的
`lock_timeout`，而不會以不安全的 age-based steal 強行繼續。
若回收 lock 的 process 本身在極窄的 recovery window 內 crash，它留下的
recovery claim 也不會被其他 waiter 強行偷走；重新送出原 prompt 執行 `prepare`
會產生新 agent job，並依既有 `runs/` 繼續，不需要破壞性地刪除 lock。

Handle registry 預設位於目標專案 root 的 `.agent-jobs/handles/`；
可在啟動 Codex 前用 `AGENT_JOBS_REGISTRY_DIR` override，確保 parent CLI 與 MCP process
繼承同一個值。registry 是本機 ephemeral capability index，不是可攜式 cache。

## CLI

通常由 skill 自動使用；以下 commands 可供診斷或整合測試：
Repository 內修改 source 或 templates 後先執行 `pnpm build`；`pnpm agent-jobs`
會直接執行最新的 `dist/agent-jobs.mjs`，避免 build log 污染 JSON 或 MCP stdio。

```bash
agent-jobs init [path] [--target all|codex|claude] [--global] [--yes] [--dry-run] [--force] [--json]
agent-jobs uninstall [path] [--target all|codex|claude] [--global] [--yes] [--dry-run] [--json]

pnpm --silent agent-jobs prepare \
  --input-data /path/to/input.json \
  --task-spec /path/to/task.md \
  --id-column-key id \
  --output-dir /path/to/output

pnpm --silent agent-jobs next --output-dir /path/to/output --job-id <id> --count 4
pnpm --silent agent-jobs status --output-dir /path/to/output --job-id <id>
pnpm --silent agent-jobs validate --output-dir /path/to/output --job-id <id>
pnpm --silent agent-jobs collect --output-dir /path/to/output --job-id <id> --format json
pnpm --silent agent-jobs doctor --output-dir /path/to/output --task-spec /path/to/task.md
pnpm --silent agent-jobs mcp
```

除 `mcp` 的 JSON-RPC stdio protocol 外，每個 command 都只輸出一個 JSON object。
不要直接在互動 terminal 啟動 `mcp` 後等待一般文字；它預期由 MCP client 透過 stdin/stdout
通訊。

## 開發與驗證

這是兩個 package 的 pnpm workspace：root `agent-jobs` 負責 installer、host
templates 與公開 CLI，`packages/runtime` 負責 batch state machine、資料驗證及 MCP。
依賴只允許 installer 指向 runtime；runtime 不知道 Codex、Claude 或安裝路徑。

兩個 package 都使用 TypeScript ESM；MCP server 使用
`@modelcontextprotocol/server`，JSON Schema 使用 Ajv。Vite 8 library mode 透過
Rolldown 產生單一 Node ESM bundle，installer 的 Markdown templates 以 `?raw`
直接嵌入；unit/integration tests 使用 Vitest。

```bash
pnpm typecheck
pnpm test
pnpm build

# 本機模擬使用者專案；playground/ 不會納入版本控制
pnpm agent-jobs init playground
```

主要 CLI commands 是 `prepare`、`next`、`status`、`validate`、`collect`、`doctor`、
`mcp`，以及安裝用的 `init`、`uninstall`。MCP 只公開 `get_assignment`、
`submit_result`、`report_failure` 三個 tools。
`submit_result` 接受二選一的 `result_json` 精確 JSON 文字（worker 預設）或
`result` JSON object（backward compatibility）。

## Error 與 isolation model

每次 retry 都使用新的 worker context。`MAX_RETRIES: 1` 代表 initial attempt 加一次 retry。
耗盡後產生 structured row error。`ON_ERROR: stop` 阻止 collect 與 AI post-processing；
`continue_successes` 只處理目前成功而且有效的 rows。

Row worker 使用 fresh context 與 read-only sandbox；project role 也停用 shell、web、apps、
memory、multi-agent、remote-plugin discovery、skill dependency installation與 image reading，
並在 instruction 層只允許 `agent_jobs` MCP。這可避免 workers 共用 conversation 或 results。

這仍是 best-effort application boundary，不是 OS security boundary：native subagents 共用
Codex host 與底層 filesystem，project/custom-agent config 也無法以全域 deny 移除所有使用者
層已登記的任意 MCP server。v1 不提供 row-level web/repo research，也不承諾最低
concurrency、特定 throughput 或大量資料的完成 SLA。
