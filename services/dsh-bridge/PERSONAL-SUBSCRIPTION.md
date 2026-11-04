# 本人 ChatGPT 订阅模式

独立 DSH 保持 `openai-completions` 文本协议，专用网关复用网站进程中的
`ChatGPTCloud` 实例，将请求转成官方 Responses 流式调用。授权令牌和续期始终
由网站服务器管理；Windows 只持有原有服务令牌，不复制 ChatGPT OAuth 凭据。

- 网站环境 `DSH_MODEL_SOURCE=chatgpt`，固定 `gpt-6-luna`。
- 智能任务页面及 API 限定 `CLOUD_CHATGPT_OWNER` 对应的启用管理员本人。
- 网关仅监听网站服务器 `127.0.0.1:47319`，认证后只为该用户的活跃任务推理。
- 既有 SSH 隧道增加 `-R 127.0.0.1:47319:127.0.0.1:47319`；Windows SSH
  key 增加 `permitlisten="127.0.0.1:47319"`，保留原有禁止执行命令及转发限制。
- DSH 的模型地址使用 `http://127.0.0.1:47319/v1`，API key 使用独立服务令牌。
- 仅接收文本；禁用工具、文件、shell 和模型覆盖。没有备用计费通道。
- 每次仅一个任务；消耗本人 ChatGPT 订阅额度，预览不扣本站周额度。
- 上游完成事件通过验证后才向 DSH 发送成功结束标志。断开、超时及权限撤销
  会中止请求，不会静默重发任务。

上线先禁用新任务，验证私有通道后切换 DSH 配置，再启用并做一次最小真实调用。
保留原网站版本、环境、隧道配置和受保护的 DSH 模型配置供回退。
账号、会员、普通聊天、绘图、QQ 机器人及原 DSH 配置不属于此次修改范围。

官方依据：[模型与推理](https://developers.openai.com/siwc/token-sharing-open-source/models-and-inference)、
[自有服务器](https://developers.openai.com/siwc/token-sharing-open-source/self-hosted-vms)。
