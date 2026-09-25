# mutt 控制台

自主代码巡检 agent 的 Web 控制台：派出任务后，mutt 会 clone 仓库、跑测试、
分诊失败、调用 LLM 打补丁、复跑验证，最后把 diff 摆出来等你验收——
三道机器门槛（测试全过 / 变异分不降 / 测试文件未被修改）全绿才允许批准合并。

## 架构

- **前端**：React 18 + TypeScript + Vite + Tailwind + shadcn/ui（三栏：任务 / 事件流 / 验收）
- **后端**：FastAPI + WebSocket，append-only 事件日志，模拟/真跑双模式
- **真跑模式**：DeepSeek API 出补丁，git 真 clone / 真 pytest / 真 merge，
  配 GitHub token 可推分支开 PR（BYOK，key 只存在用户浏览器）

## 运行

### Docker（推荐，一条命令）

```bash
docker build -t mutt-console .
docker run -p 8000:8000 mutt-console                     # 模拟模式
docker run -e DEEPSEEK_API_KEY=sk-... -p 8000:8000 mutt-console  # 真跑
```

### 本地开发

```bash
pip install -r requirements.txt
npm install && npm run build
uvicorn server.main:app --port 8000
```

打开 http://localhost:8000

## 部署到 Railway

推送到 GitHub 后，在 Railway「New Project → Deploy from GitHub repo」选择本仓库，
Railway 会自动识别 Dockerfile 构建；部署完在 Settings → Generate Domain 生成域名即可。
真跑模式在 Variables 里加 `DEEPSEEK_API_KEY`。
