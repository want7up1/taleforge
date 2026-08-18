# TaleForge

基于 DeepSeek Harness（dsh）的文字 RPG 平台：平台是壳 + 机制引擎，每个游戏是一个"剧本包"（dsh agent preset），无剧本时与工坊 agent 对话创建。单人自用，Docker 部署。

## 产品身份（已锁定，2026-08-18 用户拍板，不再返工）

- dsh 只做 AI/Agent 运行时内核；玩家前端自写且固定——所有剧本共用同一 UI，变化全部在剧本包里。不定制 dsh 自带 Web UI。
- 机制引擎两层：底层原语（状态变量 + 随机判定）+ 官方预制模块（判定/资源条/属性/物品栏）。v1 只交付预制模块，原语不对剧本开放。结构化战斗（先攻/回合/敌人实体）不做。
- 机制结果代码权威：确定性代码计算并写状态，GM 必须承接叙事，失败只能"否，但…"缓冲，不能翻案。
- 机制 UI 是固定通用组件集：状态侧栏 + 叙事流内结构化卡片，剧本启用哪个机制就亮哪个组件。

## 硬护栏（Rpgforge 教训，违反即返工）

1. 玩家等待路径上只有 GM 主循环一个 LLM 环节（含其工具调用续写步）；Director/Observer/Judge 类额外 LLM 层一律不加。
2. GM prompt 以正向工艺指令为主，硬性禁令保持个位数；输出不满意时改工艺描述，不堆规则。
3. 状态一律 id 引用 + 严格 schema + 纯 upsert；不写模糊文本匹配兜底。
4. 玩家循环好玩之前不做作者工具面板/观测面板/评测体系；调试观测用 dsh 自带 Web 工作台（loopback 直连 3090）。可视化剧本编辑器永不做。
5. 文档只留本文件 + README；历史与过程交给 git log。

## 部署（唯一目标环境）

- 生产部署永远只在 **<your-host> 的 Docker** 里，路径 `/path/to/taleforge`（该机 Docker 项目的既定布局）。不部署到其他任何环境；本地只做开发与验证。
- 该机 Docker 命令需 `sudo`（ubuntu 用户不在 docker 组）。
- 对外端口 **31415**，**绑定 127.0.0.1**：BFF 与 dsh 都没有认证，公网直接暴露等于把 API key 和存档开放给所有人。远程访问走 SSH 隧道或在 lucky 上加认证的反向代理。
- 端口须低于 32768：该机临时端口范围是 32768–60999，监听端口落在其中会偶发绑定冲突。
- 容器内 dsh 与 BFF 必须同进程空间（dsh 只信任 loopback），单容器双进程由 `docker/entrypoint.sh` 拉起。
- 持久化只有一个卷：`/path/to/taleforge/data` → 容器内 `DSH_HOME`，装着全部存档、凭据与编译产出的剧本 preset。重建容器安全，删卷即丢档。
- 仓库私有（github.com/want7up1/taleforge）。服务器按该机惯例用只读 deploy key 拉取：`~/.ssh/<deploy-key>`，已写进仓库的 `core.sshCommand`，`git pull` 免密。
- 更新流程：本地推送 → `ssh <your-host>` → `cd /path/to/taleforge && git pull && sudo docker compose up -d --build`。依赖层有缓存，仅改应用代码时重建很快。

## 关键事实（环境查不到的）

- dsh 全家锁死 `0.1.0-rc.7`。官方明示 rc 版有破坏性变更、会话格式无兼容承诺——升级 dsh 是独立项目，需先在 `runtime/dsh-home` 副本上验证旧存档可读，不随手升。
- dsh 网关只信任 loopback（127.0.0.1:3090），无认证；BFF（8790）是唯一对外入口，部署时两进程必须同容器。
- `/api` 请求/事件契约以 `node_modules/@deepseek-ai/dsh-host-apiproxy` 的 `src/api/*.ts` 为准，不凭记忆写接口。会话事件信封是 `{type, seq, time, data}`。
- `DSH_HOME=runtime/dsh-home`（gitignored）：会话存档、凭据、编译产出的剧本 preset（`.agent-presets/<id>/`）都在里面，删除即丢档。
- 剧本 preset 目录由平台代码直接写文件系统生成（官方 agentPreset RPC 不支持写自定义组合）；preset 发现无缓存，新目录立即可用，但已开会话锁定其创建时的那一代。
- 玩家剧本 preset 只挂机制工具白名单，一律不挂 bash/fs 等执行类工具（preset = shell 级权限）。
