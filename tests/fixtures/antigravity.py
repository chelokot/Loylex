#!/usr/bin/env python3
"""Local deterministic Antigravity stream-json fixture; no model calls or external services."""
import json
import os
import signal
import sys
import time

arguments = sys.argv[1:]


def option(name):
    return arguments[arguments.index(name) + 1] if name in arguments else None


assert option("--model") is not None
assert "--dangerously-skip-permissions" in arguments
assert "--disable-slash-commands" in arguments
assert option("--input-format") == "stream-json"
assert option("--output-format") == "stream-json"
assert option("--add-dir") is not None
settings = json.loads(option("--settings"))
assert settings.get("allowNonWorkspaceAccess") is True

conversation_id = option("--conversation") or "agy-conv-new-1"


def emit(value):
    print(json.dumps(value), flush=True)


def on_sigterm(_signum, _frame):
    open("agy-terminated", "w").close()
    sys.exit(143)


signal.signal(signal.SIGTERM, on_sigterm)


def messages():
    for line in sys.stdin:
        if line.strip():
            yield json.loads(line)


incoming = messages()
first = next(incoming)
assert first["event"] == "user"
content = first["message"]["content"]

emit(dict(event="init", conversation_id=conversation_id))

if "steer me" in content:
    emit(dict(event="step_update", step_update=dict(
        conversation_id=conversation_id,
        step_index=1,
        state="RUNNING",
        step_type="tool",
        tool_name="run_command",
        tool_info=dict(name="run_command", parameters=dict(CommandLine="echo hello-agy")),
    )))
    emit(dict(event="step_update", step_update=dict(
        conversation_id=conversation_id,
        step_index=1,
        state="DONE",
        step_type="tool",
        tool_name="run_command",
        tool_info=dict(name="run_command", parameters=dict(CommandLine="echo hello-agy")),
        usage=dict(input_tokens=10, output_tokens=5, cache_read_tokens=4, thinking_tokens=2),
    )))
    emit(dict(event="step_update", step_update=dict(
        conversation_id=conversation_id,
        step_index=2,
        state="DONE",
        step_type="tool",
        tool_name="search_web",
        tool_info=dict(name="search_web", parameters=dict(query="Loylex antigravity")),
        usage=dict(input_tokens=20, output_tokens=8, cache_read_tokens=6, thinking_tokens=1),
    )))
    steer = next(incoming)
    assert steer["event"] == "user"
    emit(dict(event="result", result=dict(
        conversation_id=conversation_id,
        status="SUCCESS",
        response="first turn",
        usage=dict(input_tokens=999, output_tokens=999),
    )))
    emit(dict(event="result", result=dict(
        conversation_id=conversation_id,
        status="SUCCESS",
        response=steer["message"]["content"],
        usage=dict(input_tokens=999, output_tokens=999),
    )))
elif "cancel me" in content:
    emit(dict(event="step_update", step_update=dict(
        conversation_id=conversation_id,
        step_index=1,
        state="RUNNING",
        step_type="tool",
        tool_name="run_command",
        tool_info=dict(name="run_command", parameters=dict(CommandLine="sleep 60")),
    )))
    time.sleep(30)
elif "limit fail" in content:
    emit(dict(event="result", result=dict(
        conversation_id=conversation_id,
        status="ERROR",
        error="API error 429 RESOURCE_EXHAUSTED: quota exceeded",
    )))
elif "plain fail" in content:
    emit(dict(event="result", result=dict(
        conversation_id=conversation_id,
        status="ERROR",
        error="invalid argument: bad schema",
    )))
elif "environment" in content:
    emit(dict(event="result", result=dict(
        conversation_id=conversation_id,
        status="SUCCESS",
        response=json.dumps(dict(
            proxy=os.environ.get("HTTPS_PROXY"),
            effort=option("--effort"),
            model=option("--model"),
            conversation=option("--conversation"),
            has_instructions="standing instructions" in content,
        )),
        usage=dict(input_tokens=12, output_tokens=4),
    )))
else:
    emit(dict(event="result", result=dict(
        conversation_id=conversation_id,
        status="SUCCESS",
        response=f"echo: {content}",
        usage=dict(input_tokens=15, output_tokens=5),
    )))

for _ in incoming:
    pass
