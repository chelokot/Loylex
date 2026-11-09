# T3 through Loylex

The user signs in through T3 Connect. No domain, TLS proxy, callback server, SSH
or command on the computer is needed. The computer must already have T3 Connect
enabled and remain online.

1. Ask Loylex to connect a computer by its exact T3 name, or send its Copy MCP URL.
2. Approve starting sign-in. Open the T3 Connect link and confirm the public code.
3. Approve the concrete computer after checking the displayed T3 account email
   and endpoint. Only this second approval creates the full-access MCP grant.
4. Select/register a project once, then ask for tasks naturally. Each launch,
   follow-up, read or stop retains its own live operator approval. Free status
   never reads messages. Approved read results go to the requesting agent.

The host temporarily holds account access in memory for at most ten minutes;
restart or expiry requires a new sign-in. It never persists a refresh token.
After confirmation it saves only the narrow MCP bearer in host-owned mode-0600
storage. No credential/code/private proof key is sent to the agent or Telegram.
T3 account identity never replaces the Telegram operator identity.

For the agent:

```text
loylex t3 device-connect JOB home laptop-fedora
loylex t3 connect JOB home https://ENVIRONMENT/mcp
loylex t3 connection JOB home
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

Target confirmation is proposed automatically after sign-in; never self-approve
it. A wrong/duplicate computer or different account must be resolved before
approving. Existing task approval checks and full-access/default mode checks
remain unchanged. A managed policy/provider refusal is not downgraded or bypassed.

MCP grants currently last 30 days. Reconnect on expiry or remote revocation;
local connection status does not prove the computer is online. Disconnect blocks
local access/cancels pending login, preserving files and audit; revoke the actual
grant in T3 Sharing & access too when retiring it.

File export is an approved full-access task for one non-secret project-relative
file up to 32 KiB, followed by a separately approved result read:

```text
loylex t3 export JOB home PROJECT_ID relative/report.txt
loylex t3 read JOB home THREAD_ID
loylex t3 save-export READ_APPROVAL_ID /tmp/report.txt relative/report.txt
loylex upload CHAT_ID /tmp/report.txt
```

The remote agent is instructed to refuse escaping paths/non-regular files/secrets;
this is not an OS filesystem sandbox. Local saving checks complete approved
content, exact relative path, canonical base64, byte count and SHA-256, and refuses
overwriting/symlink destinations. The digest cannot prove a remote computer honest.
Direct filesystem HTTP downloads and larger attachments are not implemented.

Install through the existing commit-specific infrastructure approval and deploy
the agent image. No gateway update, extra host package, DNS entry, firewall rule
or public listener is required. Existing unused t3-oauth.json is preserved but no
longer read. Before live acceptance verify actual sign-in, target confirmation,
harmless launch/status/read, revoked access, disconnect and restart.

Technical evidence, credential flow, fixed image crypto isolation and recovery:
[Native login review](t3-native-login-review.md). Earlier review in
[t3-bridge-review.md](t3-bridge-review.md) records the superseded callback design.
