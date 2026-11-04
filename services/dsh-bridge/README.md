# DSH 网站桥接（诊断阶段）

独立 SDK 运行入口现为 `worker.cjs`；本人 ChatGPT 订阅模式见
[PERSONAL-SUBSCRIPTION.md](./PERSONAL-SUBSCRIPTION.md)。下文保留诊断入口和模拟测试的说明，
`diagnostic.js` 自身仍只验证通信、不执行模型任务。
执行回执、自动核对和“恢复任务状态”入口见 [RECOVERY.md](./RECOVERY.md)。
原生会话的连续追问、保留与清理规则见 [FOLLOWUP.md](./FOLLOWUP.md)。
上传资料、受控文件工具和产物下载见 [FILES.md](./FILES.md)。
会员、模型倍率与整轮用量结算见 [QUOTA.md](./QUOTA.md)。
多人排队、长期历史与文件管理见 [HISTORY-QUEUE.md](./HISTORY-QUEUE.md)（本地完成，尚未部署）。

这是独立于网站及 QQ 机器人的桥接组件。当前入口**仅用于验证通信**：只监听 `127.0.0.1`，认证后返回健康状态，拒绝全部模型任务；不会启动 DSH、调用模型或修改现有 QQ 服务。尚未接入真实 DSH，不能用于网站用户对话。Node.js 24 及以上可运行。

官方文档参考：[DSH SDK server](https://github.com/deepseek-ai/deepseek-harness/blob/master/packages/sdk/server/README.md) 和 [SDK protocol](https://github.com/deepseek-ai/deepseek-harness/blob/master/packages/sdk/protocol/README.md)。SDK 与现有 QQ 的 Web API 是不同协议，且官方 SDK 当前没有逐会话取消能力，不能假定它与已安装版本兼容。后续必须针对服务器上实际版本验证实现、审批行为、持久化、取消和隔离，再单独启用真实任务。

## 诊断入口

准备一个位于**站点独立账户专用目录**内的密钥文件：

- 密钥文件：一行 64 位十六进制字符，由密码学安全的随机数生成器生成，分别安全地放到网站侧和桥接侧。不要放在命令行、日志、仓库或网页中。Unix 上文件必须为 `0600`；Windows 上必须手动设置 ACL，确保只有该服务账户和受信任管理员能读取（程序无法验证 Windows ACL）。
诊断入口不保存任务状态，也不创建状态目录或锁文件。

在 Windows PowerShell 中，设置上述绝对路径后启动（以下是占位路径，不含密钥）：

```powershell
$env:DSH_BRIDGE_TOKEN_FILE = 'C:\site-bridge-private\token.txt'
$env:DSH_BRIDGE_PORT = '47318'
node services/dsh-bridge/diagnostic.js
```

桥接端口只绑定 `127.0.0.1`，不配置公网监听。由网站服务器通过**验证服务器身份的 SSH 加密隧道**或等效受控隧道访问该端口；不要将桥接端口或 DSH 端口直接暴露公网。健康检查为 `GET /v1/health`，请求头使用 `Authorization: Bearer <密钥>` 和 `X-Site-Owner: diagnostic`，响应 `mode: diagnostic`、`jobsAvailable: false`。应在网站服务器上读取密钥文件并放入请求头，不要把密钥打印到控制台。没有令牌的请求返回 401。任意模型任务请求返回 503。

## 任务协议草稿，仅供模拟测试

`bridge.js` 接受显式注入的 `adapter.run({ sessionId, prompt, onProgress })` 和 `adapter.cancel({ sessionId })`；当前不提供生产适配器，入口也不能注入。网站后端必须认证真实用户后，作为唯一可信调用方设置 `X-Site-Owner`；浏览器不能直接设置可信身份。`POST /v1/jobs` 接受且仅接受 `{ id, conversationId, prompt }`；调用方生成并重用稳定的任务 id，所有标识限制为 1–64 位字母数字、下划线或连字符。`GET /v1/jobs/:id` 查询，`POST /v1/jobs/:id/cancel` 请求取消。幂等 ID 不能用于不同请求。调用方需自行实施权限、额度、审计、速率限制及去除敏感信息。

模拟组件把任务和进度写入状态文件，按账户及会话映射独立会话 ID；进程重启后未确认的任务变为 `unknown`，绝不会自动重发或假装完成，取消申请不代表已经停止。未知任务会阻止同一会话的新任务，需以后提供经验证的安全对账方法。完成后的桥接正文保留 24 小时；`POST /v1/jobs/:id/release` 可提前清理已结束任务的桥接正文。清理后的幂等标识保留 7 天，防止重放。总计最多 10,000 个标识、500 份正文，每个账户最多 50 份正文。未知任务不自动删除。文件可能包含回复，必须按敏感数据保护；这些清理操作不涉及未来 DSH 自身的会话存储。

会话标识或账户哈希仅用于桥接 API 访问检查，**不是文件或进程隔离**。启用真实 DSH 前必须使用独立的低权限系统账户、独立 DSH 配置与目录、受限制的文件和网络权限，并验证多用户数据及执行隔离；不能使用现有 QQ 的管理员环境。断网、超时与服务重启的结果尚需真实版本集成测试。

本地模拟测试（不连接真实 DSH、模型或服务器）：

```text
node --test tests/unit/dsh-bridge.test.js tests/unit/dsh-diagnostic.test.js
```
