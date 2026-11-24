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
elif request == "queue me":
    queued = next(incoming)
    result("first answer", queued=1)
    result(queued["message"]["content"])
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
elif request == "effort":
    result(option("--effort"))
elif request == "rate limit event":
    emit(dict(type="rate_limit_event", session_id=session,
              rate_limit_info=dict(status="rejected", resetsAt=1800000000, rateLimitType="five_hour")))
    emit(dict(type="assistant", parent_tool_use_id=None, session_id=session,
              error="rate_limit", api_error_status=429, api_error_type="rate_limit_error",
              message=dict(content=[dict(type="text", text="You've hit your limit")])))
    emit(dict(type="result", subtype="success", is_error=True,
              result="You've hit your limit · resets 5pm (UTC)", errors=[],
              api_error_status=429, api_error_type="rate_limit_error",
              session_id=session, queued_turn_count=0,
              usage=dict(input_tokens=1, cache_creation_input_tokens=0,
                         cache_read_input_tokens=0, output_tokens=0,
                         output_tokens_details=dict(thinking_tokens=0))))
    sys.exit(1)
elif request == "rate limit warning":
    emit(dict(type="rate_limit_event", session_id=session,
              rate_limit_info=dict(status="allowed_warning", resetsAt=1800000000)))
    result("still allowed")
elif request == "non limit fail":
    result(error="prompt is too long")
    sys.exit(1)

for _ in incoming:
    pass
