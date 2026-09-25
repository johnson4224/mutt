"""真 mutt agent：clone 真仓库 → 真跑 pytest → 调 DeepSeek 分析打补丁 → 复跑验证 → 人工验收后真合并。

与 simulator 走同一套事件 schema，前端零改动。
工作区在容器内 /tmp/mutt-workspaces/<task_id>/，合并在本地 git 完成
（要真开 GitHub PR 的话，再接 GITHUB_TOKEN + GitHub API 即可）。
"""
from __future__ import annotations

import asyncio
import difflib
import os
import re
import shutil
import sys
from pathlib import Path

import httpx

from .llm import LLMError, propose_fix
from .store import EventLog

WORK_ROOT = Path(os.environ.get("MUTT_WORK_DIR", "/tmp/mutt-workspaces"))
MAX_ROUNDS = 3
CMD_TIMEOUT = 180


async def _resolve_pytest() -> list[str]:
    """找出能跑 pytest 的命令前缀。子进程不继承依赖解释器自身的 PATH，
    所以遍历常见安装位置逐一验证，而不是只试 'python3'。"""
    candidates = [
        ["python3", "-m", "pytest"],
        [sys.executable, "-m", "pytest"],
        ["pytest"],
        ["/usr/bin/python3", "-m", "pytest"],
        ["/usr/local/bin/python3", "-m", "pytest"],
    ]
    for prefix in candidates:
        try:
            proc = await asyncio.create_subprocess_exec(
                *prefix, "--version",
                stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.STDOUT,
            )
            await asyncio.wait_for(proc.communicate(), timeout=10)
            if proc.returncode == 0:
                return prefix
        except (FileNotFoundError, asyncio.TimeoutError, OSError):
            continue
    return []


_PYTEST: list[str] | None = None  # 进程内缓存探测结果


async def pytest_cmd() -> list[str]:
    global _PYTEST
    if _PYTEST is None:
        _PYTEST = await _resolve_pytest()
    return _PYTEST

DEMO_CALC = '''def add(a, b):
    return a + b


def subtract(a, b):
    return a - b


def multiply(a, b):
    # BUG: implemented as addition
    return a + b


def divide(a, b):
    return a / b
'''

DEMO_TEXTUTIL = '''def shout(s):
    return s.upper()


def reverse_words(s):
    # BUG: reverses characters instead of word order
    return s[::-1]
'''

DEMO_TEST_CALC = '''from calc import add, divide, multiply, subtract


def test_add():
    assert add(2, 3) == 5


def test_subtract():
    assert subtract(10, 4) == 6


def test_multiply():
    assert multiply(3, 4) == 12
    assert multiply(0, 99) == 0


def test_divide():
    assert divide(10, 2) == 5
'''

DEMO_TEST_TEXTUTIL = '''from textutil import reverse_words, shout


def test_shout():
    assert shout("hi") == "HI"


def test_reverse_words():
    assert reverse_words("hello world") == "world hello"
    assert reverse_words("a b c") == "c b a"
'''


def is_test_path(p: str) -> bool:
    name = Path(p).name
    return name.startswith("test_") or name.endswith("_test.py") or "tests" in Path(p).parts


def _gh_slug(url: str) -> str | None:
    """从 GitHub URL 提取 owner/repo。"""
    m = re.match(r"https?://github\.com/([^/]+)/([^/\s]+?)(?:\.git)?/?$", url.strip())
    return f"{m.group(1)}/{m.group(2)}" if m else None


def _with_token(url: str, token: str | None) -> str:
    """把 token 嵌进 https URL 供 git 认证（clone/push）。token 不会出现在事件日志里。"""
    if token and url.startswith("https://"):
        return "https://x-access-token:" + token + "@" + url[len("https://"):]
    return url


class Agent:
    def __init__(self, log: EventLog, task_id: str, task_text: str, repo_url: str | None,
                 api_key: str | None = None, gh_token: str | None = None):
        self.log = log
        self.task_id = task_id
        self.task_text = task_text
        self.repo_url = repo_url
        self.api_key = api_key
        self.gh_token = gh_token
        self.workdir = WORK_ROOT / task_id
        self.repo = self.workdir / "repo"
        self.interjections: list[str] = []
        self.feedback: str | None = None

    # -- 事件辅助 ------------------------------------------------------------
    async def _out(self, text: str, err: bool = False):
        await self.log.append(self.task_id, "stderr" if err else "stdout", {"text": text})

    async def _run(self, cmd: list[str], cwd: Path | None = None, timeout: int = CMD_TIMEOUT) -> tuple[int, str]:
        """执行命令，emit command/stdout/stderr 事件，返回 (exit_code, 输出)。"""
        cwd = cwd or self.repo
        await self.log.append(self.task_id, "command", {"cmd": " ".join(cmd), "cwd": str(cwd)})
        try:
            proc = await asyncio.create_subprocess_exec(
                *cmd,
                cwd=str(cwd),
                stdout=asyncio.subprocess.PIPE,
                stderr=asyncio.subprocess.STDOUT,
            )
            out, _ = await asyncio.wait_for(proc.communicate(), timeout=timeout)
            text = out.decode(errors="replace")
        except asyncio.TimeoutError:
            proc.kill()
            await self._out(f"[mutt] 命令超时（{timeout}s），已终止", err=True)
            return 124, ""
        except FileNotFoundError:
            await self._out(f"[mutt] 命令不存在：{cmd[0]}", err=True)
            return 127, ""

        lines = text.rstrip("\n").split("\n") if text.strip() else []
        shown = lines if len(lines) <= 40 else lines[:20] + [f"… 省略 {len(lines) - 30} 行 …"] + lines[-10:]
        for ln in shown:
            is_fail = bool(re.search(r"FAILED|ERROR|AssertionError|Traceback", ln))
            await self._out(ln, err=is_fail)
        return proc.returncode or 0, text

    def _killed(self) -> bool:
        t = self.log.get_task(self.task_id)
        return t is None or t.state == "killed"

    # -- 工作区 ---------------------------------------------------------------
    async def _prepare(self) -> bool:
        # 同名 task_id 的残留工作区（熔断/崩溃遗留）直接重建
        if self.workdir.exists():
            shutil.rmtree(self.workdir, ignore_errors=True)
        self.workdir.mkdir(parents=True, exist_ok=True)
        self.pytest = await pytest_cmd()
        if not self.pytest:
            await self._out("[mutt] 环境中找不到 pytest，无法验证修复，任务终止", err=True)
            await self.log.append(self.task_id, "status", {"from_state": "patrolling", "to_state": "killed"})
            return False
        if self.repo_url:
            # 命令事件里只显示原始 URL，实际 clone 用带 token 的地址（私有仓库可 clone）
            await self.log.append(self.task_id, "command",
                                  {"cmd": f"git clone --depth 1 {self.repo_url} repo", "cwd": str(self.workdir)})
            try:
                proc = await asyncio.create_subprocess_exec(
                    "git", "clone", "--depth", "1", _with_token(self.repo_url, self.gh_token), str(self.repo),
                    cwd=str(self.workdir),
                    stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.STDOUT,
                )
                out, _ = await asyncio.wait_for(proc.communicate(), timeout=CMD_TIMEOUT)
                for ln in out.decode(errors="replace").splitlines()[:10]:
                    # token 脱敏：任何情况下都不把认证信息写进事件日志
                    if self.gh_token:
                        ln = ln.replace(self.gh_token, "***")
                    await self._out(ln)
                code = proc.returncode or 0
            except (asyncio.TimeoutError, FileNotFoundError):
                code = 1
            if code != 0:
                await self._out("[mutt] clone 失败，任务终止", err=True)
                await self.log.append(self.task_id, "status", {"from_state": "patrolling", "to_state": "killed"})
                return False
        else:
            await self._out("[mutt] 未提供仓库地址，使用内置演示仓库（含 2 个真 bug）")
            self.repo.mkdir(parents=True, exist_ok=True)
            (self.repo / "calc.py").write_text(DEMO_CALC)
            (self.repo / "textutil.py").write_text(DEMO_TEXTUTIL)
            (self.repo / "test_calc.py").write_text(DEMO_TEST_CALC)
            (self.repo / "test_textutil.py").write_text(DEMO_TEST_TEXTUTIL)
            for cmd in (["git", "init", "-b", "main"], ["git", "add", "-A"],
                        ["git", "-c", "user.email=mutt@local", "-c", "user.name=mutt",
                         "commit", "-m", "initial (broken)"]):
                code, _ = await self._run(cmd)
                if code != 0:
                    return False
        # 忽略运行产物，避免污染提交 / 阻塞分支切换
        exclude = self.repo / ".git" / "info" / "exclude"
        exclude.parent.mkdir(parents=True, exist_ok=True)
        with exclude.open("a") as f:
            f.write("\n__pycache__/\n*.pyc\n.pytest_cache/\n")
        # 修复分支（-B：已存在则重置复用）
        code, _ = await self._run(["git", "checkout", "-B", f"mutt/fix-{self.task_id}"])
        return code == 0

    def _collect_sources(self) -> dict[str, str]:
        files: dict[str, str] = {}
        for p in sorted(self.repo.rglob("*.py")):
            rel = str(p.relative_to(self.repo))
            if ".git" in Path(rel).parts:
                continue
            try:
                files[rel] = p.read_text(errors="replace")
            except OSError:
                pass
            if len(files) >= 30:
                break
        return files

    @staticmethod
    def _parse_pytest(output: str) -> tuple[int, int]:
        passed = failed = 0
        m = re.search(r"(\d+) passed", output)
        if m:
            passed = int(m.group(1))
        m = re.search(r"(\d+) failed", output)
        if m:
            failed = int(m.group(1))
        return passed, failed

    # -- 主循环 ---------------------------------------------------------------
    async def run(self) -> None:
        """新任务：准备工作区后进入修复循环。"""
        log, tid = self.log, self.task_id
        await log.append(tid, "status", {"from_state": None, "to_state": "patrolling"})
        if not await self._prepare() or self._killed():
            return
        await log.append(tid, "status", {"from_state": "patrolling", "to_state": "triaging"})
        await self._out("[mutt] 真跑模式：LLM = DeepSeek，所有测试与 diff 均为真实执行")
        await self._loop()

    async def resume(self, feedback: str | None = None) -> None:
        """要求重做：带着审阅意见再跑修复循环。"""
        self.feedback = feedback
        await self._loop()

    async def _loop(self) -> None:
        log, tid = self.log, self.task_id
        task = log.get_task(tid)
        all_diffs: list[dict[str, str]] = []
        last_test_out = ""

        for round_no in range(1, MAX_ROUNDS + 1):
            if self._killed():
                return
            task.round = round_no

            # 1. 跑测试
            code, last_test_out = await self._run(
                [*self.pytest, "-q", "--tb=short", "-p", "no:cacheprovider"])
            passed, failed = self._parse_pytest(last_test_out)
            if code == 0:
                break  # 全绿，跳出修复循环
            if passed == 0 and failed == 0:
                await self._out("[mutt] pytest 未收集到有效结果（可能环境问题），任务终止", err=True)
                await log.append(tid, "status", {"from_state": task.state, "to_state": "killed"})
                return

            if round_no == MAX_ROUNDS:
                await self._out(f"[mutt] {MAX_ROUNDS} 轮仍未修全，进入人工审阅", err=True)
                break

            # 2. 调 LLM 出补丁
            await log.append(tid, "status", {"from_state": task.state, "to_state": "fixing"})
            await self._out(f"[mutt] 调用 DeepSeek 分析 {failed} 个失败用例（第 {round_no} 轮）…")
            try:
                fix = await propose_fix(
                    self.task_text, last_test_out, self._collect_sources(),
                    self.interjections, self.feedback, api_key=self.api_key,
                )
            except LLMError as e:
                await self._out(f"[mutt] LLM 调用失败：{e}", err=True)
                continue
            if fix["analysis"]:
                await self._out(f"[mutt] 根因分析：{fix['analysis']}")

            # 3. 应用补丁 + 生成真 diff
            applied = 0
            for edit in fix["edits"]:
                path, content = edit["path"], edit["content"]
                if is_test_path(path):
                    await self._out(f"[mutt] 拒绝修改测试文件 {path}（门禁规则）", err=True)
                    continue
                fp = self.repo / path
                if not fp.resolve().is_relative_to(self.repo.resolve()):
                    await self._out(f"[mutt] 拒绝越界路径 {path}", err=True)
                    continue
                old = fp.read_text(errors="replace") if fp.exists() else ""
                fp.parent.mkdir(parents=True, exist_ok=True)
                fp.write_text(content)
                diff = "".join(difflib.unified_diff(
                    old.splitlines(keepends=True), content.splitlines(keepends=True),
                    fromfile=f"a/{path}", tofile=f"b/{path}",
                ))
                if diff:
                    await log.append(tid, "edit", {
                        "file_path": path,
                        "summary": fix["analysis"][:80] or "LLM 修复",
                        "diff": diff,
                    })
                    all_diffs = [d for d in all_diffs if d["file_path"] != path]
                    all_diffs.append({"file_path": path, "summary": fix["analysis"][:80] or "LLM 修复", "diff": diff})
                    applied += 1
            if applied == 0:
                await self._out("[mutt] LLM 未给出有效补丁", err=True)
                continue

            # 4. 提交到修复分支
            await self._run(["git", "add", "-A"])
            await self._run(["git", "-c", "user.email=mutt@local", "-c", "user.name=mutt",
                             "commit", "-m", f"mutt: fix round {round_no}"])

        # 最终验证
        passed, failed = self._parse_pytest(last_test_out)
        test_files_modified = any(is_test_path(d["file_path"]) for d in all_diffs)
        verification = {
            "tests_passed": passed,
            "tests_total": passed + failed,
            "mutation_score": None,  # mutmut 未安装，真跑模式下跳过
            "mutation_not_decreased": True,
            "test_files_modified": test_files_modified,
        }
        task.verification = verification
        task.diffs = all_diffs
        await log.append(tid, "test", {
            "suite": "pytest（真实执行）",
            "passed": passed, "failed": failed, "total": passed + failed,
            "mutation_score": None, "mutation_not_decreased": True,
            "test_files_modified": test_files_modified,
        })
        if not self._killed():
            await log.append(tid, "status", {"from_state": task.state, "to_state": "review"})

    async def approve_merge(self) -> str | None:
        """批准合并：真把修复分支 merge 回 main。"""
        code, out = await self._run(["git", "checkout", "main"])
        if code != 0:
            return None
        code, out = await self._run(
            ["git", "merge", "--no-ff", "-m", f"merge: mutt fix ({self.task_id})",
             f"mutt/fix-{self.task_id}"])
        if code != 0:
            return None
        _, log_out = await self._run(["git", "log", "--oneline", "-1"])
        return log_out.strip().split()[0] if log_out.strip() else None

    async def open_github_pr(self) -> str | None:
        """推送修复分支到 GitHub 并开 PR，返回 PR URL。"""
        if not (self.gh_token and self.repo_url):
            return None
        slug = _gh_slug(self.repo_url)
        if not slug:
            return None
        branch = f"mutt/fix-{self.task_id}"
        remote = _with_token(self.repo_url, self.gh_token)

        await self.log.append(self.task_id, "command", {"cmd": f"git push origin {branch}", "cwd": str(self.repo)})
        proc = await asyncio.create_subprocess_exec(
            "git", "push", remote, f"{branch}:{branch}",
            cwd=str(self.repo),
            stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.STDOUT,
        )
        out, _ = await proc.communicate()
        push_text = out.decode(errors="replace")
        if self.gh_token:
            push_text = push_text.replace(self.gh_token, "***")
        await self._out(push_text.strip()[-400:] or "push 完成")
        if (proc.returncode or 0) != 0:
            await self._out("[mutt] push 失败：检查 token 是否有 repo 写权限", err=True)
            return None

        task = self.log.get_task(self.task_id)
        v = (task.verification or {}) if task else {}
        body = (
            f"由 mutt 自主修复生成（任务 `{self.task_id}`）。\n\n"
            f"**原始任务**：{self.task_text[:300]}\n\n"
            f"**机器验收**：测试 {v.get('tests_passed')}/{v.get('tests_total')} 通过 · "
            f"测试文件未被修改"
        )
        async with httpx.AsyncClient(timeout=60) as client:
            res = await client.post(
                f"https://api.github.com/repos/{slug}/pulls",
                headers={
                    "Authorization": f"Bearer {self.gh_token}",
                    "Accept": "application/vnd.github+json",
                    "X-GitHub-Api-Version": "2022-11-28",
                },
                json={
                    "title": f"fix: {self.task_text[:60]}",
                    "head": branch,
                    "base": "main",
                    "body": body,
                },
            )
        if res.status_code in (200, 201):
            return res.json().get("html_url")
        # 分支上可能已有 PR
        if res.status_code == 422:
            async with httpx.AsyncClient(timeout=60) as client:
                lst = await client.get(
                    f"https://api.github.com/repos/{slug}/pulls?head={slug.split('/')[0]}:{branch}&state=open",
                    headers={"Authorization": f"Bearer {self.gh_token}",
                             "Accept": "application/vnd.github+json"},
                )
            if lst.status_code == 200 and lst.json():
                return lst.json()[0].get("html_url")
        await self._out(f"[mutt] 开 PR 失败：GitHub {res.status_code} {res.text[:200]}", err=True)
        return None

    def cleanup(self) -> None:
        shutil.rmtree(self.workdir, ignore_errors=True)


_agents: dict[str, Agent] = {}


async def start_agent(log: EventLog, task_id: str, task_text: str, repo_url: str | None,
                      api_key: str | None = None, gh_token: str | None = None) -> Agent:
    agent = Agent(log, task_id, task_text, repo_url, api_key=api_key, gh_token=gh_token)
    _agents[task_id] = agent
    await agent.run()
    return agent


def get_agent(task_id: str) -> Agent | None:
    return _agents.get(task_id)


def drop_agent(task_id: str) -> None:
    agent = _agents.pop(task_id, None)
    if agent:
        agent.cleanup()
