# 文件输入与产出

智能任务可以上传 PDF、DOCX、TXT、Markdown、CSV、JSON 和常见代码、文本资料。每轮最多 5 份，每份最多 5 MB、5 万字符，合计最多 20 万字符；PDF 最多 50 页，当前仅读取文字，扫描件需要提供文字版。

助手可生成真正保存在服务器上的文本类文件：Markdown、TXT、CSV、JSON、HTML、XML、SVG、draw.io、JavaScript、TypeScript、Python、CSS、YAML。当前不输出 PDF、DOCX 等二进制文档。每轮最多 5 个产物，每个 256 KiB、合计 1 MiB；同一会话产物最多 5 MiB。下载卡出现代表文件已保存。

## 保存和清理

- 未发送资料暂存 2 小时；发送后随会话保留，活动任务不会因到期丢失资料。站内模型模式的网站历史默认保留 30 天，可长期保留；其他接入仍为 24 小时。追问重新延长整段会话的保留期，执行端工作区仍按 24 小时清理，详见 [HISTORY-QUEUE.md](./HISTORY-QUEUE.md)。
- 网站将原件、提取正文、生成文件分开加密保存；启动时只载入文件元数据，下载及提交时才读取内容。文件按账号和会话隔离。
- 清理会话会删除原件及产物，也会清理独立 DSH 上的会话文件。清理中断可重试，残缺上下文不能继续追问。
- 网站暂存限制为每账号 25 MiB、全站 100 MiB，并为进行中的任务保留产物空间；满额时提示先清理。执行桥持久产物限制为 32 MiB。

## 执行和恢复

浏览器只提交附件编号；网站校验归属后，把已提取正文送到独立执行端。任务指纹绑定附件顺序、编号、文件名和正文摘要；断线核对使用已保存指纹，不重新发消息。

DSH 原生插件仅注册 list_documents、read_document、list_outputs、read_output、write_output。不启用通用文件系统或命令执行工具。工具不接受主机路径，按会话、任务编号和文件编号定位文件；资料正文仅作参考。

产物在工具返回成功前写入文件和本轮清单；中断恢复读取同一任务的产物。网站发布终态前保存加密副本，刷新后下载不依赖浏览器或执行进程。所有下载均使用本站受鉴权接口、强制附件下载及 nosniff，HTML、SVG 不作为本站页面执行。

## 接口

- POST /api/agent/files：{name,data}，data 为原件的规范 Base64；返回元数据 file。
- GET /api/agent/files/:id：读取本人资料的元数据。
- GET /api/agent/files/:id/download：下载本人上传原件。
- DELETE /api/agent/files/:id：移除未使用资料。
- POST /api/agent/tasks：沿用原任务格式，额外可传 attachmentIds，不接受浏览器传入的正文或任意路径。
- GET /api/agent/tasks/:taskId/artifacts/:id/download：下载本轮产物。

任务详情及会话列表中的 attachments、artifacts 只含元数据，不返回原件 Base64 或产物正文。

## 验证与上线范围

本轮仅本地预览，未修改线上服务。运行 node scripts/preview-agent.cjs 启动模拟环境，默认地址 http://127.0.0.1:8093/agent.html；不会请求真实模型。

实际 DSH 0.2.1-rc.2 配合本机模拟接口验证见 acceptance/dsh-files/real-sdk-results.json：读取资料、写 CSV、重启后读取前轮产物、恢复尚未提交终态的产物、会话隔离均通过；真实模型请求为 0。

上线需要同时更新网站文件存储、解析与接口、前端，以及独立执行端 bridge.js、sdk-adapter.js、file-protocol.js、session-files.js、file-tools.cjs、worker.cjs。独立 worker 以 enableFiles:true 显式启用；SDK 默认仍为禁用文件能力，保留其他接入方式的兼容性。现有个人订阅、站长专用权限、普通聊天和绘图额度规则不变。
