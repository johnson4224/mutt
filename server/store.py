"""In-memory store: task registry + append-only event log.

Designed to mirror a real append-only event log backend: every mutation of the
system is an event; tasks are derived state. Swap this module for a real log
reader (e.g. tailing a JSONL file / NATS / Kafka) without touching the API.
"""
from __future__ import annotations

import asyncio
import itertools
import time
from datetime import datetime, timezone
from typing import Any, Callable, Coroutine

TASK_STATES = ["patrolling", "triaging", "fixing", "review", "merged", "killed"]
RUNNING_STATES = {"patrolling", "triaging", "fixing"}

_seq_counter = itertools.count(1)
_task_counter = itertools.count(1)


def _now_iso() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="milliseconds").replace("+00:00", "Z")


class Task:
    def __init__(self, task_id: str, title: str):
        self.task_id = task_id
        self.title = title
        self.state = "patrolling"
        self.created_at = _now_iso()
        self.updated_at = self.created_at
        # machine acceptance (filled when entering review)
        self.verification: dict[str, Any] | None = None
        self.diffs: list[dict[str, str]] = []  # [{file_path, summary, diff}]
        self.pr_url: str | None = None
        self.round = 0

    def to_dict(self) -> dict[str, Any]:
        return {
            "task_id": self.task_id,
            "title": self.title,
            "state": self.state,
            "created_at": self.created_at,
            "updated_at": self.updated_at,
            "verification": self.verification,
            "diffs": self.diffs,
            "pr_url": self.pr_url,
            "round": self.round,
        }


class EventLog:
    """Append-only event log with fan-out broadcast to WebSocket clients."""

    def __init__(self) -> None:
        self.tasks: dict[str, Task] = {}
        self.events: dict[str, list[dict[str, Any]]] = {}  # task_id -> events
        self._subscribers: set[asyncio.Queue] = set()
        self._lock = asyncio.Lock()

    # -- pub/sub -----------------------------------------------------------
    def subscribe(self) -> asyncio.Queue:
        q: asyncio.Queue = asyncio.Queue(maxsize=2000)
        self._subscribers.add(q)
        return q

    def unsubscribe(self, q: asyncio.Queue) -> None:
        self._subscribers.discard(q)

    async def _broadcast(self, msg: dict[str, Any]) -> None:
        for q in list(self._subscribers):
            try:
                q.put_nowait(msg)
            except asyncio.QueueFull:
                # slow consumer: drop oldest-free strategy — just skip
                pass

    # -- writes --------------------------------------------------------------
    async def create_task(self, title: str) -> Task:
        async with self._lock:
            n = next(_task_counter)
            task = Task(f"tsk_{n:04d}", title.strip() or "未命名任务")
            self.tasks[task.task_id] = task
            self.events[task.task_id] = []
        await self._broadcast({"kind": "task", "task": task.to_dict()})
        return task

    async def append(self, task_id: str, type_: str, payload: dict[str, Any]) -> dict[str, Any]:
        seq = next(_seq_counter)
        event = {
            "event_id": f"evt_{seq:06d}",
            "task_id": task_id,
            "seq": seq,
            "type": type_,
            "timestamp": _now_iso(),
            "payload": payload,
        }
        task = self.tasks[task_id]
        async with self._lock:
            self.events[task_id].append(event)
            if type_ == "status":
                task.state = payload["to_state"]
                task.updated_at = event["timestamp"]
        await self._broadcast({"kind": "event", "event": event})
        if type_ == "status":
            await self._broadcast({"kind": "task", "task": task.to_dict()})
        return event

    # -- reads ---------------------------------------------------------------
    def list_tasks(self) -> list[dict[str, Any]]:
        return [t.to_dict() for t in sorted(self.tasks.values(), key=lambda t: t.created_at, reverse=True)]

    def get_task(self, task_id: str) -> Task | None:
        return self.tasks.get(task_id)

    def get_events(self, task_id: str, after_seq: int = 0) -> list[dict[str, Any]]:
        return [e for e in self.events.get(task_id, []) if e["seq"] > after_seq]
