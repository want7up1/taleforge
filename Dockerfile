# 单容器双进程：dsh 运行时（loopback 3090）+ BFF（3000）。
# dsh 有意只信任 loopback，因此两者必须同处一个网络命名空间。
FROM node:24-bookworm

WORKDIR /app

RUN npm config set registry https://registry.npmmirror.com \
  && npm install -g pnpm@11.22.0

# 依赖层：仅在清单变化时重装
COPY pnpm-workspace.yaml package.json pnpm-lock.yaml ./
COPY apps/bff/package.json ./apps/bff/
COPY apps/web/package.json ./apps/web/
COPY packages/scenario-compiler/package.json ./packages/scenario-compiler/
RUN pnpm install --frozen-lockfile

COPY . .
RUN pnpm run build

ENV NODE_ENV=production \
    DSH_HOME=/app/runtime/dsh-home \
    DSH_API_BASE=http://127.0.0.1:3090 \
    PORT=31415

EXPOSE 31415

CMD ["bash", "docker/entrypoint.sh"]
