# ---- 前端构建 ----
FROM node:20-alpine AS frontend
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY index.html vite.config.ts tsconfig.json tsconfig.app.json tsconfig.node.json \
     tailwind.config.js postcss.config.js components.json ./
COPY src ./src
RUN npm run build

# ---- 后端运行 ----
FROM python:3.12-slim
RUN apt-get update && apt-get install -y --no-install-recommends git \
    && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt
COPY server ./server
COPY --from=frontend /app/dist ./dist
EXPOSE 8000
# 平台注入 PORT 则监听之（Railway/Render 约定），否则默认 8000（本地 docker run）
# 真跑模式传入 key：docker run -e DEEPSEEK_API_KEY=sk-... -p 8000:8000 mutt-console
# 不传则进入模拟模式（剧本演示，接口一致）
CMD ["sh", "-c", "uvicorn server.main:app --host 0.0.0.0 --port ${PORT:-8000}"]
