"""DeepSeek LLM client.

Key 只从环境变量 DEEPSEEK_API_KEY 读，绝不写进代码/仓库。
"""
from __future__ import annotations

import json
import os

import httpx

API_BASE = os.environ.get("DEEPSEEK_API_BASE", "https://api.deepseek.com")
MODEL = os.environ.get("MUTT_LLM_MODEL", "deepseek-chat")


def llm_available() -> bool:
    return bool(os.environ.get("DEEPSEEK_API_KEY"))


class LLMError(Exception):
    pass


SYSTEM_PROMPT = """\
你是 mutt，一个自主代码修复 agent。用户会给你：任务描述、pytest 失败输出、相关源码文件。

你必须返回一个 JSON 对象（不要输出任何其他内容）：
{
  "analysis": "一句话根因分析",
  "edits": [
    {"path": "相对仓库根目录的文件路径", "content": "该文件修复后的完整内容"}
  ]
}

规则：
- content 必须是文件的完整新内容，不是 diff 片段。
- 只改让测试通过所需的最小改动。
- 绝对不要修改测试文件（test_*.py / *_test.py / tests/ 目录下的文件）。
- 如果用户有追加指令（插嘴），必须遵守。
"""


async def propose_fix(
    task_text: str,
    test_output: str,
    files: dict[str, str],
    interjections: list[str],
    feedback: str | None = None,
    api_key: str | None = None,
) -> dict:
    """让 LLM 根据失败输出与源码给出修复。返回 {"analysis": str, "edits": [...]}。

    key 优先级：BYOK（请求自带） > 环境变量。
    """
    key = api_key or os.environ.get("DEEPSEEK_API_KEY")
    if not key:
        raise LLMError("未提供 DeepSeek API key")

    parts = [f"# 任务\n{task_text}", f"# 测试输出（最后 4000 字符）\n{test_output[-4000:]}"]
    if feedback:
        parts.append(f"# 上轮审阅意见\n{feedback}")
    for ij in interjections:
        parts.append(f"# 用户追加指令\n{ij}")
    parts.append("# 源码文件")
    for path, content in files.items():
        parts.append(f"## {path}\n```\n{content[:8000]}\n```")

    payload = {
        "model": MODEL,
        "messages": [
            {"role": "system", "content": SYSTEM_PROMPT},
            {"role": "user", "content": "\n\n".join(parts)},
        ],
        "response_format": {"type": "json_object"},
        "temperature": 0.2,
        "max_tokens": 8192,
    }

    async with httpx.AsyncClient(timeout=180) as client:
        res = await client.post(
            f"{API_BASE}/chat/completions",
            headers={"Authorization": f"Bearer {key}"},
            json=payload,
        )
    if res.status_code != 200:
        raise LLMError(f"LLM HTTP {res.status_code}: {res.text[:200]}")

    data = res.json()
    text = data["choices"][0]["message"]["content"]
    try:
        out = json.loads(text)
    except json.JSONDecodeError as e:
        raise LLMError(f"LLM 返回的不是合法 JSON: {e}") from e

    edits = out.get("edits")
    if not isinstance(edits, list) or not edits:
        raise LLMError("LLM 没有给出任何 edits")
    for e in edits:
        if not isinstance(e, dict) or "path" not in e or "content" not in e:
            raise LLMError("LLM edits 格式不正确")
    return {"analysis": str(out.get("analysis", "")), "edits": edits}
