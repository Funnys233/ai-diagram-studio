# 额度与会员

此版本先供本地验收，尚未更新线上配置。网站以 DSH_MODEL_SOURCE=site 启用新的站内计费通道；原 chatgpt 配置继续保留旧站长个人预览的行为，便于独立验证和回退。

## 会员和模型

- 智能任务向普通用户及以上开放；体验用户仍使用原三个免费模型，不进入 DSH。
- 模型目录沿用对话页的账号、会员、个人 API 及订阅授权范围。普通用户可用已开放 Luna，Sol 需 Pro，Astra 需 Max；其他模型仍按已有对话规则。
- 平台中转、共享 GPT 的倍率直接取 weekly-quota.multiplierFor。模型选择器显示当时倍率；个人 API 不扣本站周额度。
- 当前支持 OpenAI 兼容模型和 ChatGPT Responses；通过 OpenAI 兼容中转提供的 Grok、Claude 可用，原生 Anthropic Messages 不在本版 DSH 目录中。
- 每段会话固定模型，换模型需要新任务。倍率在本轮开始时冻结，后续配置变动不追补旧账。

## 简化后的计算

将同一轮 DSH 内所有模型请求（工具循环、重试、自动压缩）汇总为一笔账：

    本轮点数 = (累计输入 token + 累计输出 token × 5) × 对话同款倍率 ÷ 1000

沿用现有精度及最低消耗规则：积分保存为千分之一点，完整用量按整轮加权后向上取整，最低为 0.1 × 模型倍率点。

例如平台 Sol 为 x15，累计输入 1000、输出 100，则本轮扣 22.5 点。缓存读取和写入已经包括在输入总量中；推理 token 已包括在输出中，两者均不再额外相加。DSH 报出的美元成本不用于本站扣点。

未返回完整 token 数据时明确显示“含估算”：对缺用量的实际内部请求逐次保留兜底估算，并与已知用量取足够覆盖的数值；继续调用前核对剩余额度。确认未提交、零次调用或无消耗限流的请求不扣点。上传、下载、刷新、状态核对本身不调用模型、不扣模型点数。

## 结算和恢复

本站周额度和对话共用同一账本。每轮使用稳定的 agent:任务编号作为调用账目，重复提交和重复恢复只会返回原结算。界面和账号页从同一账目读数。

网站重启时保留独立 DSH 的预留，不把网页进程退出当作任务失败。任务恢复后用原回执结算。SDK 已停止但网关仍有本进程的调用未完成时，继续保留核对状态和占用，等最后一次用量回调写入后才发布终态。

私有网关也保存本轮调用的纯数字用量快照，以补足 SDK 中断时遗漏的已确认消耗；两者核对后整轮只结算一次。跨周任务仍使用开始时的额度窗口，不挪用新周余额。

## 模型连接与凭据

独立执行端只得到任务限定的能力凭证，不得到平台 API Key 或 ChatGPT OAuth。网站网关按任务编号查已保存的账号、模型和权限，不接受调用方传入地址、账号或倍率。

worker 使用 bridge.token 派生任务凭证；网站验证使用 DSH_BRIDGE_TOKEN_FILE 中的同一密钥。网关仍只监听回环地址，经原 SSH 通道接入。任务结束后清空不再需要的模型密钥快照。

订阅工具请求按[官方 SIWC preview 要求](https://developers.openai.com/siwc/token-sharing-open-source/preview-limitations)使用 store:false、stream:true 和命名空间内的受控 function tools；不扩大原有订阅授权范围。

## 本地验证与部署

运行 node scripts/preview-agent.cjs 可打开本地模拟模型与点数预览；其账本仅为当前预览的独立模拟，不读取真实账号。

验证记录：

- tests/unit/agent-quota.test.js：计价、重复结算、跨周、账号隔离、未知用量、取消与网关回调。
- tests/integration/agent-quota.test.js：真实网站账号和周账本、模型权限、重复提交、私有网关和重启。
- acceptance/dsh-quota/live-browser-results.json：真实会员登录、模型选择、DSH 模拟多步结果与账号扣点一致。
- acceptance/dsh-usage/real-sdk-results.json 和 acceptance/dsh-quota/model-gateway-native-results.json：同版本 DSH、工具循环、续问独立用量、恢复不重复累计；均使用本机模拟接口，真实模型请求为 0。

上线必须同时更新网站账本、模型通道、前端、执行桥、SDK adapter、file-protocol.js 和新增 usage.js，以及 worker。还需要将网站 DSH_MODEL_SOURCE 改为 site；仅更新网页不能启用新计费。
