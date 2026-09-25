"""mutt console backend — FastAPI + WebSocket.

双模式：
- 配置了 DEEPSEEK_API_KEY → 真跑：clone 仓库、跑 pytest、调 DeepSeek 打补丁、真合并
- 未配置 → 模拟：内存剧本演示全流程（接口、schema 完全一致）

接口：
  GET  /api/status                     运行模式 {mode: live|sim}
  GET  /api/tasks                      任务列表
  POST /api/tasks                      新建任务 {text}（text 里含 GitHub URL 则 clone 真仓库）
  GET  /api/tasks/{task_id}/events     事件回放 ?after_seq=
  POST /api/tasks/{task_id}/interject  运行中插嘴 {text}
  POST /api/tasks/{task_id}/review     验收 {action: approve|redo|kill, feedback?}
  WS   /ws                             全量事件流（snapshot + event + task）
"""
from __future__ import annotations

import asyncio
import json
import re
from contextlib import asynccontextmanager
from pathlib import Path

from fastapi import FastAPI, HTTPException, WebSocket, WebSocketDisconnect
from fastapi.responses import FileResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel

from .agent import drop_agent, get_agent, start_agent
from .llm import llm_available
from .simulator import run_fix_round, run_task
from .store import RUNNING_STATES, EventLog

log = EventLog()
_bg_tasks: set[asyncio.Task] = set()
REPO_URL_RE = re.compile(r"https?://[^\s'\"]+(?:\.git)?")


def _spawn(coro) -> None:
    t = asyncio.create_task(coro)
    _bg_tasks.add(t)
    t.add_done_callback(_bg_tasks.discard)


def _extract_repo_url(text: str) -> str | None:
    m = REPO_URL_RE.search(text)
    return m.group(0) if m else None


async def _seed() -> None:
    """种子历史；真跑模式下不再自动起演示任务（避免空跑 LLM 烧钱）。"""
    hist = await log.create_task("修复 CI 里 payments 模块的 ImportError")
    await log.append(hist.task_id, "status", {"from_state": None, "to_state": "patrolling"})
    await log.append(hist.task_id, "command", {"cmd": "git clone …/payments.git", "cwd": "/tmp/mutt/work"})
    await log.append(hist.task_id, "status", {"from_state": "patrolling", "to_state": "triaging"})
    await log.append(hist.task_id, "status", {"from_state": "triaging", "to_state": "fixing"})
    await log.append(hist.task_id, "edit", {
        "file_path": "src/payments/__init__.py",
        "summary": "补全缺失的懒加载导入",
        "diff": "--- a/src/payments/__init__.py\n+++ b/src/payments/__init__.py\n@@ -1,2 +1,3 @@\n from .core import charge\n+from .receipts import issue_receipt\n",
    })
    hist.verification = {"tests_passed": 87, "tests_total": 87,
                         "mutation_score": 91, "mutation_not_decreased": True,
                         "test_files_modified": False}
    await log.append(hist.task_id, "test", {
        "suite": "pytest + mutmut", "passed": 87, "failed": 0, "total": 87,
        "mutation_score": 91, "mutation_not_decreased": True, "test_files_modified": False,
    })
    await log.append(hist.task_id, "status", {"from_state": "fixing", "to_state": "review"})
    await log.append(hist.task_id, "status", {"from_state": "review", "to_state": "merged"})
    hist.pr_url = "https://github.com/acme/payments/pull/482"
    await log.append(hist.task_id, "done", {"summary": "PR #482 已合并", "pr_url": hist.pr_url})

    if not llm_available():
        demo = await log.create_task("pytest 挂了，去修好（演示任务，自动开始）")
        _spawn(run_task(log, demo.task_id))


@asynccontextmanager
async def lifespan(app: FastAPI):
    await _seed()
    yield


app = FastAPI(title="mutt console", lifespan=lifespan)


# ------------------------------- REST --------------------------------------

class CreateTaskReq(BaseModel):
    text: str
    api_key: str | None = None  # BYOK：用户自带 DeepSeek key，仅存于用户浏览器
    gh_token: str | None = None  # BYOK：GitHub token，批准后真推分支开 PR


class InterjectReq(BaseModel):
    text: str


class ReviewReq(BaseModel):
    action: str  # approve | redo | kill
    feedback: str | None = None


@app.get("/api/status")
def status():
    return {"mode": "live" if llm_available() else "sim", "llm": "deepseek" if llm_available() else None}


@app.get("/api/tasks")
def list_tasks():
    return {"tasks": log.list_tasks()}


@app.post("/api/tasks", status_code=201)
async def create_task(req: CreateTaskReq):
    if not req.text.strip():
        raise HTTPException(400, "text must not be empty")
    task = await log.create_task(req.text)
    byok = (req.api_key or "").strip() or None
    gh = (req.gh_token or "").strip() or None
    if byok or llm_available():
        _spawn(start_agent(log, task.task_id, req.text, _extract_repo_url(req.text),
                           api_key=byok, gh_token=gh))
    else:
        _spawn(run_task(log, task.task_id))
    return {"task": task.to_dict()}


@app.get("/api/tasks/{task_id}/events")
def task_events(task_id: str, after_seq: int = 0):
    if log.get_task(task_id) is None:
        raise HTTPException(404, "task not found")
    return {"events": log.get_events(task_id, after_seq)}


@app.post("/api/tasks/{task_id}/interject", status_code=202)
async def interject(task_id: str, req: InterjectReq):
    task = log.get_task(task_id)
    if task is None:
        raise HTTPException(404, "task not found")
    if task.state not in RUNNING_STATES:
        raise HTTPException(409, f"task is {task.state}, interject only while running")
    if not req.text.strip():
        raise HTTPException(400, "text must not be empty")
    await log.append(task_id, "interject", {"author": "you", "text": req.text.strip()})
    agent = get_agent(task_id)
    if agent is not None:
        agent.interjections.append(req.text.strip())
        await log.append(task_id, "stdout", {"text": f"[mutt] 插嘴已入队，将在下一轮 LLM 调用时生效：「{req.text.strip()}」"})
    else:
        await log.append(task_id, "stdout", {"text": f"[mutt] 收到插嘴：「{req.text.strip()}」（模拟模式，仅记录）"})
    return {"ok": True}


def _check_gates(task) -> list[str]:
    v = task.verification or {}
    missing = []
    if not (v.get("tests_total") and v.get("tests_passed") == v.get("tests_total")):
        missing.append("测试未全通过")
    if not v.get("mutation_not_decreased"):
        missing.append("变异分下降")
    if v.get("test_files_modified"):
        missing.append("测试文件被修改")
    return missing


@app.post("/api/tasks/{task_id}/review")
async def review(task_id: str, req: ReviewReq):
    task = log.get_task(task_id)
    if task is None:
        raise HTTPException(404, "task not found")
    agent = get_agent(task_id)

    if req.action == "kill":
        if task.state in ("merged", "killed"):
            raise HTTPException(409, f"task already {task.state}")
        await log.append(task_id, "status", {"from_state": task.state, "to_state": "killed"})
        await log.append(task_id, "done", {"summary": "已熔断终止，工作区已回收", "pr_url": None})
        drop_agent(task_id)
        return {"task": task.to_dict()}

    if task.state != "review":
        raise HTTPException(409, f"task is {task.state}, review action needs state=review")

    if req.action == "approve":
        missing = _check_gates(task)
        if missing:
            raise HTTPException(422, {"detail": "机器验收未全绿", "missing": missing})
        if agent is not None:
            commit = await agent.approve_merge()
            pr_url = await agent.open_github_pr()
            if pr_url:
                task.pr_url = pr_url
                summary = f"已合并并开出 PR：{pr_url}"
            else:
                summary = f"已合并到本地 main（commit {commit}）" if commit else "已合并"
        else:
            task.pr_url = f"https://github.com/acme/payments/pull/{483 + task.round}"
            summary = f"PR 已合并：{task.pr_url}"
        await log.append(task_id, "status", {"from_state": "review", "to_state": "merged"})
        await log.append(task_id, "done", {"summary": summary, "pr_url": task.pr_url})
        return {"task": task.to_dict()}

    if req.action == "redo":
        note = req.feedback or "要求重做：回到修复阶段"
        await log.append(task_id, "interject", {"author": "you", "text": note})
        if agent is not None:
            _spawn(agent.resume(note))
        else:
            _spawn(run_fix_round(log, task_id, task.round + 1))
        return {"task": task.to_dict()}

    raise HTTPException(400, f"unknown action: {req.action}")


# ------------------------------ WebSocket -----------------------------------

@app.websocket("/ws")
async def ws(websocket: WebSocket):
    await websocket.accept()
    q = log.subscribe()
    try:
        await websocket.send_text(json.dumps({"kind": "snapshot", "tasks": log.list_tasks()}))
        while True:
            msg = await q.get()
            await websocket.send_text(json.dumps(msg))
    except WebSocketDisconnect:
        pass
    finally:
        log.unsubscribe(q)


# --------------------------- static frontend --------------------------------

DIST = Path(__file__).resolve().parent.parent / "dist"
if DIST.exists():
    app.mount("/assets", StaticFiles(directory=DIST / "assets"), name="assets")

    @app.get("/{full_path:path}")
    def spa(full_path: str):
        f = DIST / full_path
        if full_path and f.is_file():
            return FileResponse(f)
        return FileResponse(DIST / "index.html")
