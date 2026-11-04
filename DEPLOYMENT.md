# 部署说明

## 生成独立云端配置

```bash
node scripts/cloud-tools.cjs setup --origin https://draw.example.com
```

这会生成权限受限的 `.env.cloud`，内含随机主密钥和初始管理员密码，不会打印这些值。使用本机编辑器查看并保管；首次创建数据目录后，环境中的初始密码不会覆盖已有账号密码。
该域名为示例，请替换成自己实际持有的 HTTPS 来源。

## 使用容器

```bash
docker compose -f compose.cloud.yml up -d --build
```

容器仅将 8080 绑定到宿主机回环地址。用 Nginx/Caddy 等配置 HTTPS 反向代理，完整保留 Host；SSE 路径需要关闭代理缓冲并设置合适超时。Nginx 片段见 `deploy/nginx.conf.example`。
`PUBLIC_ORIGIN` 必须与浏览器访问来源一致。不要直接将本地模式暴露到公网。

## 数据与限制

- 数据保存在 `cloud-data` 持久卷。主密钥丢失后无法解密，应离线单独备份。
- 同一数据目录只运行一个应用实例。并行模型请求不等于多进程共享存储。
- 启动后配置平台模型；注册体验用户的免费池仅在管理员显式配置相应模型后可用。
- 按服务器和上游承载调整 `CLOUD_TOTAL_CONCURRENCY`；示例初值不是容量承诺。
- DSH 默认关闭。启用须另配执行端、鉴权与隔离，不应公开桥接端口。

离线备份、恢复和主密钥轮换使用 `scripts/cloud-tools.cjs`，操作前停止唯一应用实例，并显式传入 `--confirm-stopped`。不要把生产数据或配置放入仓库。
