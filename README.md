# TaleForge

基于 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) 的自托管文字 RPG 平台。平台提供固定的玩家界面与通用机制引擎（骰子判定、资源条、属性、物品栏）；每个游戏是一个独立"剧本包"，可纯叙事也可调用机制；没有剧本时，与内置工坊 agent 对话即可从零创建。

## 快速开始

```sh
pnpm install
pnpm dev               # 并行启动 dsh 运行时 + BFF + 前端
```

首次打开在「设置」页填入 DeepSeek API Key 即可开玩，保存后立即生效（存进 dsh 数据卷，不入 Git）。

- 玩家入口：http://localhost:5173 （开发）/ http://localhost:31415 （生产构建）
- dsh 调试工作台：http://127.0.0.1:3090 （仅 loopback）

## 部署

单容器双进程（dsh + BFF 必须同进程空间），只监听 `127.0.0.1:31415` —— 两者都没有认证，公网直接暴露等于把 API Key 和存档送人。远程访问走 SSH 隧道或加了认证的反向代理。

```sh
ssh <your-host>
cd /path/to/taleforge && sudo docker compose up -d --build
```

远程访问开隧道：`ssh -L 31415:127.0.0.1:31415 <your-host>`，然后浏览器打开 http://localhost:31415

## 结构

| 目录 | 内容 |
|---|---|
| `apps/web` | 玩家前端（Vite + React，固定 UI） |
| `apps/bff` | 平台服务：托管前端、受控转发 dsh `/api`、mux→SSE 桥、剧本编译 |
| `packages/` | 机制引擎插件与剧本编译器 |
| `presets/` | 内置剧本源 |
| `runtime/dsh-home` | dsh 数据目录（会话存档/凭据/编译产出的剧本，gitignored） |
