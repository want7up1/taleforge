# TaleForge

自托管的文字 RPG 平台：AI GM 按剧本运营一部长篇互动小说。平台提供固定的玩家界面与通用机制（骰子判定、资源条、属性、物品栏、经验等级）；每个游戏是一份独立的剧本（`story.json`），可纯叙事也可调用机制；没有剧本时，与内置工坊对话即可从零创建。只对接 DeepSeek。

## 快速开始

```sh
pnpm install
pnpm dev               # 并行启动平台服务（31415）与前端开发服务器（5173）
```

首次打开在「设置」页填入 DeepSeek API Key 即可开玩，保存后立即生效（存进数据卷，不入 Git）。

- 玩家入口：http://localhost:5173 （开发）/ http://localhost:31415 （生产构建）

## 一个回合怎么跑

```
玩家行动 → 组装上下文（固定前缀 + 前情提要 + 最近几章原文 + 本回合尾部）
        → 正文步：开思考、流式写一整章（要掷骰就在这里掷，代码裁决）
        → 结算步：关思考、强制调 settle_turn，把这一章的锚点、数值、物品、经验与下一步选项结清
        → 写进会话日志、推给界面 → 被动观测 → 后台按需整理前情提要
```

结算由代码强制发生，选项是结构化字段——"GM 忘了记账""缺行动选项"在结构上不会出现。

## 部署

单容器单进程，只监听 `127.0.0.1:31415`——平台没有认证，公网直接暴露等于把 API Key 和存档送人。远程访问走 SSH 隧道或加了认证的反向代理。

```sh
ssh <your-host>
cd /path/to/taleforge && sudo docker compose up -d --build
```

远程访问开隧道：`ssh -L 31415:127.0.0.1:31415 <your-host>`，然后浏览器打开 http://localhost:31415

## 结构

| 目录 | 内容 |
|---|---|
| `apps/web` | 玩家前端（Vite + React，固定 UI） |
| `apps/bff` | 平台服务：托管前端、剧本库、会话与存档、回合入口、SSE 推流 |
| `packages/engine` | 内核：回合流水线、上下文组装、结算步的组装与裁决、前情提要、被动观测 |
| `packages/llm` | DeepSeek 客户端（fetch + SSE，工具调用分片拼装，推理回传，缓存用量） |
| `packages/store` | 会话存储：每个会话一个 JSONL 事件日志，状态由日志折叠 |
| `packages/mechanics` / `progress` | 机制与幕进度的纯裁决逻辑 |
| `packages/scenario-compiler` | 剧本格式（schema）、GM 固定前缀、剧本目录扫描 |
| `packages/workshop` | 剧本发布、留档与回滚，工坊对话的工具 |
| `runtime/dsh-home` | 本地数据根（剧本源、会话、存档、设置，gitignored；名字沿用旧版以免改数据卷路径） |

写剧本看 [AUTHORING.md](AUTHORING.md)。本地校验：`node scripts/validate-story.ts <story.json>`；会话日志回归：`node scripts/refold.ts <数据根>/v2/sessions/<id>.jsonl`。
