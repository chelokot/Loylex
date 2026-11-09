# T3 through Loylex

The bridge runs exclusively in the host supervisor. The agent proposes operations;
the existing live Telegram operator button approves each one. It never receives a
T3 bearer token, pairing code, OAuth authorization code or PKCE verifier.
This implementation can be installed by the pre-T3 host updater: all host code
uses its existing installed module paths. No T3 executable or SDK is installed.

## User flow

1. In T3, enable T3 Connect so the computer is reachable. Copy **Settings →
   Environments → environment menu → Copy MCP URL**. Send that URL to Loylex
   with a name such as `home`. Never send pairing codes or tokens to chat.
2. Loylex proposes `connect`. Approve its Telegram button. The host posts a
   **Подключить T3** link valid for ten minutes. Open it and choose **Full access**
   on the T3 consent screen. An already authorized T3 browser can approve;
   otherwise enter the pairing code **on T3's page**, not in Telegram.
3. The browser confirms completion. Ask Loylex to show projects, approve that
   read, then select a project and approve registering its exact folder once.
4. Say “на домашнем компьютере в проекте X запусти тесты”. Approve the task;
   it requests full-access/default. No inner Loylex command-by-command approvals.
   Configure a default model for the project in T3 first.
   A provider or organization policy that cannot honor this mode must refuse.
5. Status needs no approval. Reading the result needs a separate approval,
   including each additional page or truncated-text continuation. Ask Loylex for
   the result after approval; the broker does not post private transcripts itself.

T3 currently issues MCP client access for **30 days**, with **no refresh grant**.
Loylex detects local expiry; HTTP 401/403 reports reconnect required. Reconnect
uses the same flow. Local credential status does not probe remote revocation or
prove the computer is online. Reconnecting invalidates previous pending task
approvals. Project registrations survive only when the endpoint is unchanged.

## One-time host prerequisite

A browser on a phone cannot reach the VPS loopback address. A trusted host
administrator must provision one public HTTPS callback. This cannot be completed
inside the agent container. Do not expose either supervisor port (8790/8791).

On the host, create `~/.config/loylex/t3-oauth.json` owned by the supervisor user,
mode **0600**, containing only:

```json
{"callbackUrl":"https://YOUR-LOYLEX-HTTPS-DOMAIN/t3/callback"}
```

Use an existing authenticated-admin-managed TLS reverse proxy on that domain.
Only the exact callback path is public; there is no public administrative API.
For an existing Nginx TLS server, the location is:

```nginx
location = /t3/callback {
    access_log off;
    error_log /dev/null crit;
    proxy_pass http://127.0.0.1:8792;
    proxy_set_header Host $host;
    proxy_connect_timeout 5s;
    proxy_read_timeout 120s;
    add_header Cache-Control no-store always;
    add_header Referrer-Policy no-referrer always;
}
```

Disable request/query logging for this path in **every** proxy, WAF, tracing and
error-reporting layer: the URL contains a single-use code. Use no analytics.
TLS/DNS provisioning is host maintenance, not an agent-executable installer.
Restart the supervisor after provisioning. Its callback listener binds only
`127.0.0.1:8792`, with four request slots and socket timeouts. Missing/invalid
callback configuration never prevents normal supervisor startup; connect fails
with setup instructions. OAuth callbacks check state, issuer, exact callback,
PKCE S256, expiry, a configuration lease and single use before saving access.

Install this reviewed commit with the existing commit-specific **infrastructure**
approval. It uses only pre-existing installed files, including the bootstrap fix.
Gateway code/authentication need no update. Publish/deploy the agent image for
`loylex t3` convenience commands. No automatic T3/package updater is added.

## Commands for the agent

Use the current job ID; the gateway resolves its original chat/reply address.
The user talks naturally; these commands save the agent from writing JSON files.

```text
loylex t3 help
loylex t3 connect JOB home https://ENVIRONMENT/mcp
loylex t3 connection JOB home
loylex t3 capabilities JOB home
loylex t3 projects JOB home [CURSOR]
loylex t3 use JOB home PROJECT_ID EXACT_FOLDER
loylex t3 run JOB home PROJECT_ID 'Run tests and report'
loylex t3 send JOB home PROJECT_ID THREAD_ID 'Follow-up'
loylex t3 sessions JOB home PROJECT_ID [CURSOR]
loylex t3 status JOB home THREAD_ID
loylex t3 read JOB home THREAD_ID [AFTER_POSITION]
loylex t3 continue JOB home THREAD_ID ITEM_ID TEXT_OFFSET
loylex t3 stop JOB home THREAD_ID
loylex t3 disconnect JOB home
loylex t3 result APPROVAL_ID
```

Except `connection`, `status`, `result` (retrieving an already approved result)
and local export saving, every remote operation needs a fresh operator button.
No generic tool, URL override, permission answer, mode change or schedule exists.
`disconnect` disables local access and cancels pending login; it preserves host
credential/audit files. Revoke the grant in T3 **Sharing & access** too when removing
access remotely. It does not interrupt existing remote tasks automatically.

## File export

MCP client tokens are restricted to `/mcp` upstream; they cannot be reused to
call filesystem HTTP APIs. The bridge therefore supports **task-based export of
one non-secret project file up to 32 KiB**, not a generic filesystem download.

```text
loylex t3 export JOB home PROJECT_ID relative/report.txt
# Approve the full-access export task, poll status, approve a separate read:
loylex t3 read JOB home THREAD_ID
loylex t3 save-export READ_APPROVAL_ID /tmp/report.txt relative/report.txt
# If the original request asks for the file in Telegram:
loylex upload CHAT_ID /tmp/report.txt
```

The full export prompt is in the immutable approval package. The remote agent is
instructed to resolve the real path, refuse escapes/non-regular files/secrets and
return a bounded JSON/base64 manifest. **These are instructions to an autonomous
full-access agent, not an OS filesystem sandbox.** Projects are organizational
boundaries in T3. The approved task already grants the remote agent broad local
command access; exporting a file does not narrow that grant.

Saving requires a successful approved read, exact requested relative path, a
complete manifest, canonical base64, byte count and SHA-256. Conflicting content
is refused. It creates the caller-selected local path exclusively, mode 0600,
without overwriting files or following a destination symlink. The digest verifies
transport consistency, not authenticity against a malicious remote computer.
Large files and direct attachments are not supported by this version.

## Storage, failure and recovery

Host files `t3-machines.json`, `t3-credentials.json`, `t3-pending.json` use owner-only
regular files, no symlink reads, bounded JSON, atomic replacement and fsync. Tokens
exist only in the credentials file; registry/packages/results contain references
and grant identities. Up to 20 computers/pending logins are supported. No OAuth
secrets are in agent/gateway mounts. Existing Podman token-secret registrations
remain supported until migrated by an approved reconnect.

All T3 HTTP traffic uses verified HTTPS port 443 and a validated public address
pinned per connection with TLS hostname verification. Mixed private/public DNS,
loopback, metadata, reserved and multicast addresses fail closed. OAuth discovery
must name the reviewed paths on the exact approved origin; no redirects or
server-provided alternate endpoints are followed. Network responses are inert
JSON, never shell commands, dynamic imports or executable downloads.

Mutations and code exchange are never retried automatically. A callback spends
its pending login durably before exchange; a lost exchange needs a new sign-in.
A crash between credentials/registry replacement fails closed until reconnect.
Other approval queue limits, one-hour expiry, saved-package integrity, live button
checks, audit ordering and unknown-outcome handling remain unchanged.
Status calls only `t3_thread_wait(timeoutMs=1)` and returns a fixed allowlist;
no title/summary/transcript is included. Two T3 tool slots and 120 status polls per
minute remain. Send checks mode/folder before dispatch; upstream has no atomic
mode/folder lease, so a simultaneous human change remains a documented race.

Before live acceptance: record the home T3 version/artifact provenance, verify
HTTPS callback delivery without logs, approve a harmless task, poll status,
approve a read/export, and exercise deny, replay, expiry, revoked grant, offline
computer and supervisor restart. Local tests cannot establish these live facts.

Rollback: stop/interrupt remote tasks first, revoke the grant in T3, restore the
previous reviewed supervisor modules/commit through host maintenance, and restore
its backed-up registry if needed. Remove the exact callback proxy location when
retiring it. Keep credentials, approval packages, audit and Git history; do not
roll back while a remote task is still running without arranging its shutdown.
