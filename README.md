# 禅道 MCP Server

面向禅道 21.x REST API v1 与 Web JSON 接口的 MCP 服务。采用“一个业务域一个统一工具”的接口形式，支持 Bug、需求、测试用例、产品、项目、我的任务、用户和文档查询；写操作默认关闭。

## 生产安全基线

- 凭据仅保存在当前用户目录，不写入 MCP 配置、仓库或命令行参数。
- 默认 `allowWrites: false`，创建、编辑、解决和关闭操作会在访问禅道前被拒绝。
- 日志只写入 `stderr`，采用结构化 JSON，并清洗密码、Token、Cookie、账号和连接地址。
- HTTP 请求有超时、响应体上限和同源重定向限制；不读取系统代理，避免内网请求被意外转发。
- Token 失效时只自动刷新一次；瞬时错误只重试幂等的 GET 请求，POST 不自动重放。
- 列表数量和 MCP 单次响应大小均有硬上限，超限时显式失败。
- 工具声明包含 MCP `readOnlyHint`、`destructiveHint`、`idempotentHint` 和 `openWorldHint`。
- 支持 SIGINT/SIGTERM 优雅关闭，并提供不返回业务数据的健康检查。

> 如果禅道仅提供 HTTP，MCP 会记录 `insecure_http_transport` 警告。账号密码和 Token 在链路中仍依赖内网边界保护；生产环境建议为禅道启用 HTTPS。

## 环境要求

- Node.js 18 或更高版本
- 禅道开源版 16.5+；本项目已按禅道 21.x Token API 适配
- 对目标禅道 REST API v1 的网络访问权限

## 安装和配置

从 npm 安装：

```bash
npm install -g @yanzhang123/zentao-mcp
zentao-mcp-setup
```

也可以不全局安装：

```bash
npx -y --package @yanzhang123/zentao-mcp zentao-mcp-setup
```

从源码部署：

```bash
npm ci
npm run setup
npm run verify
```

`npm run setup` 会在交互式终端中隐藏密码输入，并将配置写入：

- Windows：`%USERPROFILE%\.zentao-mcp\config.json`
- macOS/Linux：`~/.zentao-mcp/config.json`

如果需要指定其他本地文件，只在 MCP 进程中设置 `ZENTAO_CONFIG_PATH`。账号、密码和 Token 不得写入代码、日志或仓库文件。

配置示例（只使用脱敏占位符）：

```json
{
  "zentao": {
    "baseUrl": "https://zentao.example.local/zentao",
    "account": "YOUR_ACCOUNT",
    "password": "YOUR_PASSWORD",
    "skipSsl": false,
    "allowWrites": false,
    "timeoutMs": 30000,
    "maxRetries": 2,
    "maxPageSize": 100,
    "maxResponseChars": 200000
  }
}
```

配置约束：

- `baseUrl` 必须是禅道部署根地址并保留子路径，例如 `/zentao`；不能填写 `my-work-*.html` 页面。
- URL 只允许 HTTP/HTTPS，不允许内嵌凭据、查询参数或片段。
- `skipSsl` 仅用于可信内网中的自签名证书，生产环境优先配置可信 CA。
- 只有明确接受写入风险时才将 `allowWrites` 改为 `true`。
- `timeoutMs`：1000–120000；`maxRetries`：0–5；`maxPageSize`：1–500；`maxResponseChars`：10000–1000000。

## MCP 客户端配置

npm 方式：

```json
{
  "mcpServers": {
    "zentao": {
      "command": "npx",
      "args": [
        "-y",
        "--package",
        "@yanzhang123/zentao-mcp",
        "zentao-mcp"
      ]
    }
  }
}
```

本地源码方式：

```json
{
  "mcpServers": {
    "zentao": {
      "command": "node",
      "args": ["D:/develop/zentao-mcp/dist/bundle.cjs"]
    }
  }
}
```

如配置文件不在默认位置：

```json
{
  "mcpServers": {
    "zentao": {
      "command": "node",
      "args": ["D:/develop/zentao-mcp/dist/bundle.cjs"],
      "env": {
        "ZENTAO_CONFIG_PATH": "D:/secure-config/zentao-mcp.json"
      }
    }
  }
}
```

## MCP 工具

| 工具 | 只读 action | 写 action |
|---|---|---|
| `zentao_bugs` | `list`, `view` | `create`, `resolve`, `close` |
| `zentao_stories` | `list`, `view` | `create`, `close` |
| `zentao_testcases` | `list`, `view` | `create` |
| `zentao_products` | `list`, `view` | — |
| `zentao_projects` | `list`, `view` | — |
| `zentao_tasks` | `my`, `execution`, `view` | — |
| `zentao_users` | `list`, `view`, `me` | — |
| `zentao_docs` | `tree`, `view` | `create`, `edit`, `createModule`, `editModule` |
| `zentao_system` | `health` | — |

`zentao_system` 的 `health` 仅验证鉴权和 API 可达性，返回服务版本、读写模式和 TLS 状态，不返回用户资料或业务内容。

`zentao_tasks` 的 `my` 对应禅道 `my-work-task-*.html` 页面，`browseType` 可选 `assignedTo`（默认）、`finishedBy`、`closedBy`。该工具复用本地账号建立 Cookie 会话，但不会把 Cookie 写入磁盘或日志。

## 运维与验证

```bash
# 构建和全部自动化测试
npm test

# 生产依赖漏洞扫描
npm run audit:prod

# 测试、漏洞扫描和发布包内容检查
npm run verify
```

诊断日志为逐行 JSON，可按 `event` 检索：

- `server_started` / `server_stopping`
- `tool_call_started` / `tool_call_succeeded` / `tool_call_failed`
- `auth_token_refreshed`
- `http_request_retry`
- `write_action_blocked`
- `insecure_http_transport`

仓库中的 `test-doc-api.ts` 是只读诊断脚本，只返回可达性和数量摘要，不创建、编辑或输出禅道业务内容。

## 发布检查

发布新版本前先更新版本号，并在 PR 中提交 `package.json` 与 `package-lock.json`：

```bash
npm version patch
npm ci
npm run verify
```

PR 合并到 `main` 后，GitHub Actions 会使用 npm Trusted Publishing 自动发布。已存在的版本会安全跳过，不使用或保存长期 npm Token。

真实配置文件、`.env`、响应转储、日志和任何凭据都不得进入发布包或版本控制。

## License

MIT
