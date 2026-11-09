#!/usr/bin/env python3
"""Local deterministic Claude Code stream-json fixture; no model calls or external services."""
import json
import os
import sys

arguments = sys.argv[1:]


def option(name):
    return arguments[arguments.index(name) + 1] if name in arguments else None


assert arguments[0] == "--print"
assert option("--input-format") == "stream-json"
assert option("--output-format") == "stream-json"
assert option("--permission-mode") == "bypassPermissions"
assert option("--setting-sources") == "project"
assert option("--append-system-prompt") == "standing instructions"
assert "AskUserQuestion" in option("--disallowedTools").split(",")
session = option("--resume") or option("--session-id")
assert session


def emit(value):
    print(json.dumps(value), flush=True)


def messages():
    for line in sys.stdin:
        yield json.loads(line)


def assistant(*content):
    emit(dict(type="assistant", parent_tool_use_id=None, session_id=session,
              message=dict(content=list(content))))


def result(text=None, error=None, queued=0):
    emit(dict(type="result", subtype="error_during_execution" if error else "success",
              is_error=bool(error), result=text, errors=[error] if error else [],
              session_id=session, queued_turn_count=queued,
              usage=dict(input_tokens=10, cache_creation_input_tokens=5,
                         cache_read_input_tokens=20, output_tokens=7,
                         output_tokens_details=dict(thinking_tokens=3))))


incoming = messages()
first = next(incoming)
assert first["session_id"] == session
emit(dict(type="system", subtype="init", session_id=session))
request = first["message"]["content"]

if request == "steer me":
    assistant(dict(type="text", text="working"),
              dict(type="tool_use", id="bash-1", name="Bash", input=dict(command="echo example")))
    steer = next(incoming)
    emit(dict(type="user", parent_tool_use_id=None, session_id=session,
              message=dict(content=[dict(type="tool_result", tool_use_id="bash-1")])))
    assistant(dict(type="tool_use", id="search-1", name="WebSearch", input=dict(query="Loylex")))
    assistant(dict(type="text", text=steer["message"]["content"]))
    result(steer["message"]["content"])
elif request == "interrupt me":
    assistant(dict(type="tool_use", id="bash-1", name="Bash", input=dict(command="sleep 60")))
    control = next(incoming)
    assert control["request"]["subtype"] == "interrupt"
    open("interrupted", "w").close()
    emit(dict(type="control_response", response=dict(subtype="success",
                                                      request_id=control["request_id"])))
    result(error="interrupted")
    sys.exit(1)
elif request == "ask me":
    emit(dict(type="control_request", request_id="permission-1",
              request=dict(subtype="can_use_tool", tool_name="Bash")))
    response = next(incoming)["response"]
    assert response["request_id"] == "permission-1"
    result(f"denied: {response['subtype']}")
elif request == "fail":
    result(error="You've hit your limit")
    sys.exit(1)
elif request == "environment":
    result(json.dumps(dict(proxy=os.environ.get("HTTPS_PROXY"), session=session)))

for _ in incoming:
    pass
