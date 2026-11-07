# T3 operations through the host approval broker

This PR prepares a disabled-by-default bridge. It does not connect a computer,
install T3, merge the PR, update the gateway, or roll out the supervisor.
The authenticated callback and operator checks are unchanged.

## Policy

| Operation | Approval | Returned to the requesting agent |
| --- | --- | --- |
| `t3-status` | None | Machine alias, thread/run IDs, fixed run-state enum |
| `t3` / `launch` | One live operator button | Receipt only |
| `t3` / `send` | One live operator button per message | Receipt only |
| `t3` / `read` | One live operator button per bounded page | Session messages and pagination |
| `t3` / `list`, `projects`, `capabilities` | One live operator button per request | Requested metadata, potentially private |
| `t3` / `interrupt` | One live operator button | Stop receipt only |

`launch` explicitly requests `full-access` and `default`, in the registered
project root. This authorizes an autonomous task, including the local agent's
choice of commands, rather than a fixed shell-command allowlist. There is no
second Loylex approval layer inside that task. A provider that cannot honor the
explicit mode must refuse it; it must not silently downgrade to supervised mode.
Ordinary model questions and environmental failures remain possible.

`send` queues one follow-up. The bridge checks the project folder and the session's
shell metadata first and refuses supervised/plan sessions. It does not change
an existing session's mode or automatically answer a local permission prompt.
There is an upstream race if a human changes the session mode/folder between
verification and dispatch; T3's API has no conditional send lease for those fields.

A creation/send receipt and a status poll do not grant transcript access. Reading
the result needs a separate approval. Approved content becomes available to the
requesting agent through the existing approval-status endpoint; it is not posted
as a transcript into the group by the broker. This is disclosure to the agent,
not an enforced destination-limited file export. Direct file downloads, attachments,
schedules, arbitrary tool names, arbitrary URLs, mode changes, and approval answers
are intentionally absent.

## Host provisioning (not performed by the PR)

The VPS host, outside the agent container, needs a regular mode-0600 registry:
`~/.config/loylex/t3-machines.json`:

```json
{
  "home": {
    "endpoint": "https://YOUR-T3-CONNECT-ENVIRONMENT/mcp",
    "tokenSecret": "loylex-t3-home",
    "projects": { "PROJECT_ID": "C:\\Users\\you\\project" }
  }
}
```

The matching OAuth access credential must be provisioned into that **host-owned**
Podman secret through trusted host maintenance. Never put a token into an operation,
chat, repository, environment URL or agent volume. The bridge is not a replacement
OAuth authorization server. It does not yet implement OAuth onboarding or refresh;
a missing/expired credential fails closed. Before live use, finish host-side OAuth
login/refresh with the operator's environment URL and test revocation. The earlier
suggestion to authorize the agent container directly would bypass this approval
boundary and should not be used for this design.

Use the existing commit-specific infrastructure approval to install the reviewed
supervisor modules. No gateway or container changes are needed. Record the installed
previous commit and back up the host registry before activation. The registry is
host-controlled; no agent API provisions or edits it. The endpoint/secret reference and a digest of connection configuration are
snapshotted into each package and checked again at execution. Unrelated registered
project paths are not copied into the package. Project root paths
are included in the package and rechecked against T3 before dispatch.

## Request examples

Submit each JSON file with `loylex approve submit REQUEST.json`. `jobId` is the
current Telegram job; replace the example value and all IDs. This uses existing
job-to-chat resolution. The free status request responds immediately without
creating a queue item, review or Telegram button:

```json
{"jobId":1805,"operation":{"kind":"t3-status","machine":"home","threadId":"mcp:THREAD_ID"}}
```

Create an autonomous task:

```json
{"jobId":1805,"operation":{"kind":"t3","machine":"home","action":"launch","arguments":{"projectId":"PROJECT_ID","title":"Test build","message":"Run the project's test suite and report the result."}}}
```

Read the result after approving a separate package:

```json
{"jobId":1805,"operation":{"kind":"t3","machine":"home","action":"read","arguments":{"threadId":"mcp:THREAD_ID","limit":20,"maxCharsPerItem":10000}}}
```

`loylex approve status APPROVAL_ID` returns the saved outcome. Each subsequent read
page is a new approval, using `afterPosition`/`nextPosition` and checking `hasMore`.
For truncated individual text, this version does not expose item/text-offset reads.
Sending requires `projectId`, `threadId` and `message`; listing requires `projectId`.
`projects` and `capabilities` accept an empty argument object. `list` and `projects`
accept bounded `cursor` and `limit`. `interrupt` requires only `threadId`.

## Failure and resource boundaries

The existing immutable-package hash, one-hour expiry, live button binding,
queue/disk limits, durable executing transition and restart interruption apply.
No failed or unknown-outcome mutation is retried automatically. Inspect T3 before
resubmitting after a connection loss. Launch/send use a saved client request key
where upstream supports it; a new approval is a new operation, not a retry.

The stdlib-only client uses verified HTTPS on port 443, a host-registered `/mcp`
endpoint, no redirects, bounded JSON/SSE responses (2 MiB), response deadlines,
two simultaneous tool connections and a global 120-per-minute status limit.
Free polling calls only `t3_thread_wait(timeoutMs=1)` and returns a positive
allowlist of fields, dropping even hypothetical added transcript/summary fields.
MCP transport sessions are closed after use. Errors do not include remote text,
credentials or protocol-session IDs. Revocation/401 requires host intervention;
there is no shell/network installer or dynamic code loading.

## Validation and rollout gate

Automated tests cover the real local broker's pending/button/executing flow,
wrong sender, replay, unknown outcome, target changes, status without a button,
status content filtering, mode refusal, pagination and the HTTP/SSE transport.
They use inert mock T3 responses, not a live computer. Existing broker authentication,
message guards, audit and deployment tests remain required.

Before activation: authenticate to the actual environment; run a harmless task,
verify one click starts full-access execution without local permission prompts;
confirm status does not reveal messages; approve one result read; test deny,
expiry, disconnect, revoked OAuth and restart. Verify secret isolation on the host
and in agent/gateway containers. Until those pass, this is a draft integration.

Rollback: stop issuing T3 requests, revoke its OAuth grant on the T3 computer,
restore the prior supervisor commit/modules through host maintenance, and keep the
approval database/packages for audit. Other Loylex services and authentication
remain unchanged. Do not roll back while an approved remote task is still running
without first stopping it on the computer or with an approved interrupt.
