#!/usr/bin/env python3
"""Local deterministic stdio fixture; no model calls or external services."""
import json
import os
import sys
from datetime import datetime, timezone


def emit(value):
    print(json.dumps(value), flush=True)


def usage(total, last, turn="turn-test"):
    def counters(value):
        return dict(totalTokens=value, inputTokens=value, cachedInputTokens=0,
                    cacheWriteInputTokens=0, outputTokens=0, reasoningOutputTokens=0)
    emit(dict(method="thread/tokenUsage/updated", params=dict(
        threadId="thread-test", turnId=turn, tokenUsage=dict(
            total=counters(total), last=counters(last)))))


for line in sys.stdin:
    request = json.loads(line)
    method = request["method"]
    params = request.get("params", {})
    if method == "initialized":
        continue
    result = {}
    if method in ("thread/start", "thread/resume"):
        assert params["approvalPolicy"] == "never"
        assert params["sandbox"] == "danger-full-access"
        assert params["developerInstructions"] == "standing instructions"
        result = dict(thread=dict(id="thread-test"))
    elif method == "turn/start":
        result = dict(turn=dict(id="turn-test"))
    elif method == "turn/steer":
        assert params["expectedTurnId"] == "turn-test"
        assert params["threadId"] == "thread-test"
        if params["input"][0]["text"] == "reject":
            emit(dict(id=request["id"], error=dict(code=-32000, message="no active turn")))
            continue
        result = dict(turnId="turn-test")
    emit(dict(id=request["id"], result=result))
    if method == "thread/resume":
        usage(90, 50, "previous-turn")
    if method == "turn/start" and params["input"][0]["text"] == "journal":
        sessions = os.path.join(os.environ["CODEX_HOME"], "sessions", "2026", "10", "06")
        os.makedirs(sessions, exist_ok=True)
        with open(os.path.join(sessions, "rollout-test-thread-test.jsonl"), "a") as journal:
            journal.write(json.dumps(dict(
                timestamp=datetime.now(timezone.utc).isoformat(), type="event_msg",
                payload=dict(type="item_completed", thread_id="thread-test", item=dict(
                    type="Extension", kind="web.search", id="exec-search", query="France M51.3")))) + "\n")
        emit(dict(method="item/completed", params=dict(threadId="thread-test",
            item=dict(type="agentMessage", id="final", phase="final_answer", text="Done"))))
        emit(dict(method="turn/completed", params=dict(threadId="thread-test",
            turn=dict(id="turn-test", status="completed"))))
    elif method == "turn/start":
        usage(100, 10)
        emit(dict(method="item/completed", params=dict(threadId="thread-test",
            item=dict(type="agentMessage", id="comment", phase="commentary", text="working"))))
        emit(dict(method="item/started", params=dict(threadId="thread-test",
            item=dict(type="commandExecution", id="cmd", command="echo example"))))
    if method == "turn/steer":
        usage(120, 20)
        emit(dict(method="item/completed", params=dict(threadId="thread-test",
            item=dict(type="agentMessage", id="final", phase="final_answer",
                text=params["input"][0]["text"]))))
        emit(dict(method="turn/completed", params=dict(threadId="thread-test",
            turn=dict(id="turn-test", status="completed"))))
