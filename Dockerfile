# 单进程：BFF 与内核（packages/engine）同一个 Node 进程，直连 DeepSeek。
# v2 起不再有 dsh 运行时，也就不再需要"两进程同容器"的入口脚本。
FROM node:24-bookworm

WORKDIR /app

RUN npm config set registry https://registry.npmmirror.com \
  && npm install -g pnpm@11.22.0

# 依赖层：仅在清单变化时重装
COPY pnpm-workspace.yaml package.json pnpm-lock.yaml ./
COPY apps/bff/package.json ./apps/bff/
COPY apps/web/package.json ./apps/web/
COPY packages/engine/package.json ./packages/engine/
COPY packages/llm/package.json ./packages/llm/
COPY packages/store/package.json ./packages/store/
COPY packages/scenario-compiler/package.json ./packages/scenario-compiler/
COPY packages/mechanics/package.json ./packages/mechanics/
COPY packages/progress/package.json ./packages/progress/
COPY packages/workshop/package.json ./packages/workshop/
RUN pnpm install --frozen-lockfile --registry=https://registry.npmmirror.com

COPY . .
RUN pnpm run build

# 数据根沿用 dsh 时代的路径：宿主机数据卷挂载点不用改
ENV NODE_ENV=production \
    TALEFORGE_HOME=/app/runtime/dsh-home \
    PORT=31415

EXPOSE 31415

CMD ["node", "apps/bff/src/index.ts"]
