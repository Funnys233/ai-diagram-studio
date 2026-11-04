# 第三方组件

- **draw.io / diagrams.net**：通过 `https://embed.diagrams.net/` 嵌入，完整编辑器没有随本仓库分发。上游项目为 <https://github.com/jgraph/drawio>，其代码和服务使用条件分别适用。
- **dsh-codex-effort-slider**：强度滑块参考并改编自 <https://github.com/Microqian2th/dsh-codex-effort-slider>，来源提交记录保留在 `public/reasoning-slider.js` 文件头。MIT 许可证全文位于 `public/third-party/dsh-codex-effort-slider-LICENSE.txt`。
- **KaTeX**：前端公式排版资源位于 `public/vendor/katex/`，MIT 许可证保留在该目录的 `LICENSE`。
- **DeepSeek Harness**：可选执行桥接面向外部 SDK 协议；本项目不分发上游 SDK，也不声称其为原创。上游为 <https://github.com/deepseek-ai/deepseek-harness>。
- npm 依赖 `mammoth`、`pdfjs-dist`、`yauzl` 及其依赖通过包管理器安装，版本见 `package-lock.json`，分别遵循各自许可证。

本仓库根目录的 MIT 许可证只适用于本项目有权授权的代码；第三方版权声明保持有效。
