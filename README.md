# TaleForge

基于 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) 的自托管文字 RPG 平台。平台提供固定的玩家界面与通用机制引擎（骰子判定、资源条、属性、物品栏）；每个游戏是一个独立"剧本包"，可纯叙事也可调用机制；没有剧本时，与内置工坊 agent 对话即可从零创建。

## 快速开始

```sh
cp .env.example .env   # 填入 DEEPSEEK_API_KEY
pnpm install
pnpm dev               # 并行启动 dsh 运行时 + BFF + 前端
```

- 玩家入口：http://localhost:5173 （开发）/ http://localhost:3000 （生产构建）
- dsh 调试工作台：http://127.0.0.1:3090 （仅 loopback）

## 部署

生产环境固定为 <your-host> 的 Docker（`/path/to/taleforge`），只监听 127.0.0.1:3000。详见 `CLAUDE.md`。

```sh
ssh <your-host>
cd /path/to/taleforge && sudo docker compose up -d --build
```

## 结构

| 目录 | 内容 |
|---|---|
| `apps/web` | 玩家前端（Vite + React，固定 UI） |
| `apps/bff` | 平台服务：托管前端、受控转发 dsh `/api`、mux→SSE 桥、剧本编译 |
| `packages/` | 机制引擎插件与剧本编译器 |
| `presets/` | 内置剧本源 |
| `runtime/dsh-home` | dsh 数据目录（会话存档/凭据/编译产出的剧本，gitignored） |
