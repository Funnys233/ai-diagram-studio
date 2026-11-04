# 连续追问

在智能任务里完成首轮后，可直接在底部输入修改要求。同一会话显示全部轮次；“新任务”建立独立上下文。刷新不重发消息，草稿按账号、会话保留。最多 20 轮；站内模式的网站历史默认保留 30 天，可长期保留，其他接入仍为 24 小时；可下载 Markdown 或整体清理。执行端上下文仍按 24 小时清理，超过期限保留的网站结果只能查看和下载，详见 [HISTORY-QUEUE.md](./HISTORY-QUEUE.md)。

## 请求与执行

- 首轮仍为 `POST /api/agent/tasks`，正文 `{id, conversationId, prompt}`。
- 追问额外携带 `parentTaskId`。网站和执行桥都检查账号、会话、最新父轮及执行状态。客户端只传本轮文字，不上传或拼接历史。
- 桥接复用同一独立 SDK session；新 SDK 进程通过 `session/resume` 读取服务器保存的原生历史，不能找不到历史就静默建立空会话。
- `GET /api/agent/conversations/:conversationId` 返回完整轮次及能否继续。旧版已完成任务可通过只读核对已有 SDK 会话启用追问，不重新请求模型。
- `DELETE /api/agent/conversations/:conversationId` 清理整段。先持久保存清理意图，再逐轮确认删除；网络中断、重启后不能把残缺会话当成完整上下文。

## 中断与保留

每轮执行回执绑定任务编号，防止恢复时把上一轮正文认作这一轮结果。尚未送达执行端的追问，通过包含父轮的指纹确认并阻止迟到提交；刷新、重复点击不会重做请求。未知任务保持占用直到确认已结束。

活动会话保留前面各轮，终止后统一续期；发现缺轮、已清理内容、到期、20 轮上限时，明确要求新建任务。现阶段仍为站长本人预览，固定 Luna，使用个人 ChatGPT 订阅；不改变普通对话、绘图、会员和本站周额度规则。

## 验证与本地预览

`node scripts/preview-agent.cjs` 启动独立本地模拟环境，地址默认为 `http://127.0.0.1:8093/agent.html`。模拟环境不请求真实模型，不读线上账号或额度数据。

相关验证：`tests/unit/agent-tasks.test.js`、`tests/unit/dsh-bridge.test.js`、`tests/unit/dsh-sdk-adapter.test.js`、`tests/integration/agent-tasks.test.js`、`tests/integration/agent-recovery.test.js`、`tests/e2e/agent-followup-e2e.mjs`。上线需要同时更新网站、独立桥和 SDK adapter，不能只更新网页。

同版本运行时验证见 `acceptance/dsh-followup/real-sdk-results.json`：使用 DSH `0.2.1-rc.2`、同版 pi-ai 插件及内核 `1.4.0`，配合本机模拟接口，确认 SDK 进程及桥接重启后仍会发送既有用户和助手历史，新会话保持隔离。该验证为 3 次本机模拟请求，真实模型请求为 0，未修改线上服务。
