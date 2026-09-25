"""Fake event-stream simulator: walks a task through the full state machine
patrolling -> triaging -> fixing -> review -> (merged | killed | fixing again)
producing realistic events (commands, stdout/stderr, edits, test verdicts).

Replace this with a tailer over the real mutt event log when going live.
"""
from __future__ import annotations

import asyncio
import random

from .store import EventLog

DIFF_TRIAGE = """--- a/src/mutt/triage.py
+++ b/src/mutt/triage.py
@@ -41,7 +41,10 @@ class TriageResult:
 def classify_failure(output: str) -> FailureKind:
-    if "AssertionError" in output:
-        return FailureKind.ASSERTION
-    return FailureKind.UNKNOWN
+    lowered = output.lower()
+    if "assertionerror" in lowered:
+        return FailureKind.ASSERTION
+    if "modulenotfounderror" in lowered or "importerror" in lowered:
+        return FailureKind.MISSING_DEP
+    if "timeout" in lowered:
+        return FailureKind.FLAKY
+    return FailureKind.UNKNOWN
@@ -58,3 +61,6 @@ def rank_causes(kinds: list[FailureKind]) -> list[FailureKind]:
-    return sorted(set(kinds))
+    order = {FailureKind.MISSING_DEP: 0, FailureKind.ASSERTION: 1,
+             FailureKind.FLAKY: 2, FailureKind.UNKNOWN: 3}
+    return sorted(set(kinds), key=lambda k: order[k])
"""

DIFF_RUNNER = """--- a/src/mutt/runner.py
+++ b/src/mutt/runner.py
@@ -12,9 +12,13 @@ async def run_pipeline(repo: str, budget_s: int = 600):
     sandbox = await Sandbox.create(repo)
-    result = await sandbox.exec("pytest -x -q")
-    if result.exit_code != 0:
-        report = triage(result.stderr)
-        patch = propose_patch(report)
-        await sandbox.apply(patch)
+    try:
+        result = await sandbox.exec("pytest -x -q", timeout=budget_s)
+        if result.exit_code != 0:
+            report = triage(result.stderr)
+            patch = propose_patch(report)
+            await sandbox.apply(patch)
+            await sandbox.exec("pytest -q", timeout=budget_s)
+    finally:
+        await sandbox.teardown()
     return report
"""

STDOUT_BOOT = [
    "Cloning into '/tmp/mutt/work/repo'...",
    "remote: Enumerating objects: 1482, done.",
    "remote: Counting objects: 100% (1482/1482), done.",
    "Checking connectivity... done.",
    "HEAD is now at 9f31ac2 fix: retry transient sandbox errors",
]

STDERR_FAIL = [
    "=================================== FAILURES ===================================",
    "____________________ test_classify_failure_missing_dep _____________________",
    "",
    "    def test_classify_failure_missing_dep():",
    ">       assert classify_failure('ModuleNotFoundError: No module named \\'yaml\\'') == FailureKind.MISSING_DEP",
    "E       AssertionError: assert <FailureKind.UNKNOWN: 99> == <FailureKind.MISSING_DEP: 2>",
    "",
    "src/mutt/triage.py:44: AssertionError",
    "=========================== short test summary info ============================",
    "FAILED tests/test_triage.py::test_classify_failure_missing_dep - AssertionError",
    "!!!!!!!!!!!!!!!!!!!!!! stopping after 1 failures !!!!!!!!!!!!!!!!!!!!!!!",
    "1 failed, 86 passed in 4.12s",
]

STDOUT_PASS = [
    "................................................................................",
    "................................................................................",
    "87 passed in 5.43s",
    "",
    "mutmut run --paths-to-mutate src/mutt/triage.py",
    "- Mutation testing summary -",
    "killed: 41, survived: 4, timeout: 0, suspicious: 0",
    "mutation score: 91%",
]


async def _emit_out(log: EventLog, task_id: str, lines: list[str], stream: str = "stdout",
                    delay: float = 0.28) -> None:
    for ln in lines:
        await log.append(task_id, stream, {"text": ln})
        await asyncio.sleep(delay)


async def _guard_killed(log: EventLog, task_id: str) -> bool:
    task = log.get_task(task_id)
    return task is None or task.state == "killed"


async def run_fix_round(log: EventLog, task_id: str, round_no: int) -> None:
    """One fixing round: edits -> tests -> review gate. Round 1 deliberately
    ships a regression in mutation score so the approve gate stays red."""
    task = log.get_task(task_id)
    if task is None:
        return
    task.round = round_no

    await log.append(task_id, "command", {"cmd": "pytest -x -q", "cwd": "/tmp/mutt/work/repo"})
    await _emit_out(log, task_id, STDERR_FAIL, stream="stderr", delay=0.16)
    if await _guard_killed(log, task_id):
        return

    await log.append(task_id, "status", {"from_state": task.state, "to_state": "fixing"})
    await log.append(task_id, "edit", {
        "file_path": "src/mutt/triage.py",
        "summary": "classify_failure 支持大小写不敏感匹配，新增 MISSING_DEP / FLAKY 分类",
        "diff": DIFF_TRIAGE,
    })
    await asyncio.sleep(0.6)
    await log.append(task_id, "edit", {
        "file_path": "src/mutt/runner.py",
        "summary": "pipeline 增加 try/finally 沙箱回收，补丁后复跑全量测试",
        "diff": DIFF_RUNNER,
    })
    await asyncio.sleep(0.8)
    if await _guard_killed(log, task_id):
        return

    await log.append(task_id, "command", {"cmd": "pytest -q && mutmut run", "cwd": "/tmp/mutt/work/repo"})
    await _emit_out(log, task_id, STDOUT_PASS, delay=0.2)

    regression = round_no == 1
    verification = {
        "tests_passed": 87,
        "tests_total": 87,
        "mutation_score": 91,
        "mutation_not_decreased": not regression,
        "test_files_modified": False,
    }
    task.verification = verification
    task.diffs = [
        {"file_path": "src/mutt/triage.py", "summary": "classify_failure 分类修复", "diff": DIFF_TRIAGE},
        {"file_path": "src/mutt/runner.py", "summary": "runner 沙箱回收与复跑", "diff": DIFF_RUNNER},
    ]
    await log.append(task_id, "test", {
        "suite": "pytest + mutmut",
        "passed": verification["tests_passed"],
        "failed": verification["tests_total"] - verification["tests_passed"],
        "total": verification["tests_total"],
        "mutation_score": verification["mutation_score"],
        "mutation_not_decreased": verification["mutation_not_decreased"],
        "test_files_modified": verification["test_files_modified"],
    })
    await log.append(task_id, "status", {"from_state": "fixing", "to_state": "review"})


async def run_task(log: EventLog, task_id: str) -> None:
    """Full patrol lifecycle for a freshly created task."""
    task = log.get_task(task_id)
    if task is None:
        return
    await log.append(task_id, "status", {"from_state": None, "to_state": "patrolling"})
    await log.append(task_id, "command", {
        "cmd": "git clone https://github.com/acme/payments.git /tmp/mutt/work/repo",
        "cwd": "/tmp/mutt/work",
    })
    await _emit_out(log, task_id, STDOUT_BOOT, delay=0.22)
    await log.append(task_id, "command", {"cmd": "git log --oneline -3 && git status -sb", "cwd": "/tmp/mutt/work/repo"})
    await _emit_out(log, task_id, [
        "9f31ac2 fix: retry transient sandbox errors",
        "b02e71d chore: bump pytest to 8.3",
        "4ca90ef feat: add FailureKind enum",
        "## main...origin/main",
    ], delay=0.15)
    if await _guard_killed(log, task_id):
        return

    await log.append(task_id, "status", {"from_state": "patrolling", "to_state": "triaging"})
    await log.append(task_id, "stdout", {
        "text": "[mutt] 进入分诊：复现失败、定位根因、评估修复预算",
    })
    await run_fix_round(log, task_id, round_no=1)
