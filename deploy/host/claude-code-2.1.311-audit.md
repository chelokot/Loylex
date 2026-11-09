# Claude Code 2.1.311 review

Reviewed 2026-11-09 for the operator's explicit request to run Loylex jobs on
Claude Code while Codex remains installed and selectable.

## Provenance and installed artifact

Version 2.1.311 is the `stable` npm dist-tag (published 2026-10-26); `latest`
was 2.1.319, three days old, and was not chosen. The image downloads exactly one
file, the native Linux x64 executable, from Anthropic's documented release path
`https://downloads.claude.ai/claude-code-releases/2.1.311/linux-x64/claude`,
checks its SHA-256 and runs a version check. No package manager, install script,
wrapper or npm dependency is involved.

| Artifact | SHA-256 |
| --- | --- |
| `claude` 2.1.311 linux-x64 executable | `86dc1fcc69498159eaf15f446613e847010f9036bfbbdffd4c49350be8489ada` |
| `manifest.json` for 2.1.311 | `d456e7293d621e6e09dd73b1d2a112bef62dae08d1ee44c1065356e64da65c0d` |
| Release signing key `claude-code.asc` | `bd70a5e4a268002704024ceba7f8446024114e94f3f0bdd11c23a9e592be81c6` |

The pin was verified through two independent paths. `manifest.json.sig` is a
good GPG signature by "Anthropic Claude Code Release Signing
<security@anthropic.com>", key `31DD DE24 DDFA B679 F42D 7BD2 BAA9 29FF 1A7E CACE`,
which matches the fingerprint and key URL published at
<https://code.claude.com/docs/en/setup#binary-integrity-and-code-signing>.
The signed manifest's `linux-x64` checksum equals the pin. The same bytes are also
inside `@anthropic-ai/claude-code-linux-x64@2.1.311` from the npm registry, whose
tarball matched its SHA-512 SRI. That npm package has no provenance attestation.
The executable is a closed-source, Bun-compiled ELF (293,776,752 bytes, standard
glibc interpreter, no setuid bit), so this is a provenance review, not a source
audit.

## Runtime boundary

Loylex starts one private `claude --print` stream-json process per job, like the
Codex app-server: no daemon, socket or shared session. Fixed argv:

- `--permission-mode bypassPermissions`, the equivalent of Codex
  `danger-full-access` with `approvalPolicy: never`. Interactive control requests
  are answered with an error, so the run fails closed.
- `--setting-sources project` reads only the workspace `CLAUDE.md` and project
  settings, never user settings. Startup requires `CLAUDE.md` to be a symlink to
  the image-verified `AGENTS.md`.
- `--strict-mcp-config` with no MCP configuration starts no MCP servers.
- Terminal-only and in-process scheduling tools are disallowed.
- Standing instructions use `--append-system-prompt`, which the default system
  prompt snapshot records once per session.

Self-update cannot run. `DISABLE_AUTOUPDATER=1` and
`CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC=1` are set, and the binary is root-owned
in a read-only image filesystem. Updates arrive only as reviewed image pins.

Only the Claude child gets `HTTPS_PROXY=http://host.containers.internal:3128`
(with `NO_PROXY` for internal hosts) and `CLAUDE_CODE_OAUTH_TOKEN`, read from the
`loylex-claude-oauth-token` Podman secret. Codex, the gateway and other agent
processes are unchanged. Commands Claude runs inherit both values, the same
exposure the agent already has to Codex's `auth.json`. The host proxy is
versioned in [`squid.conf`](squid.conf) and installed by `install-host.sh`.

Authentication is the operator's own subscription token. Anthropic's published
terms reserve subscription OAuth for ordinary individual use and direct products
that serve other users to API keys. The operator accepted that risk; switching to
an API key needs only a different secret and variable.

## Validation

Protocol behaviour was checked against the real 2.1.311 executable using a local
Messages API stub:

- A message written mid-turn is injected after the next tool result as "The user
  sent a new message while you were working", in the same turn and transcript.
- The `interrupt` control request ends the turn.
- `--resume` appends to the same session.
- The persona arrives through the `CLAUDE.md` symlink. Instructions stay out of
  the message history.

Memory, measured with the stub holding a turn open: about 94 MB anonymous RSS per
session plus about 75 MB of shared executable pages (20 sessions about 2.0 GB).
Codex app-server is about 45 MB. Over the last 30 days production peaked at 5
concurrent jobs, so `LOYLEX_MAX_CONCURRENT_JOBS` drops from an unused 50 to 12.

`bun run check` passed. Live verification with the real token (steer, resume,
interrupt, peak memory under load) is pending the operator's approval of host
installation and deployment.

## Rollout and rollback

1. Install the host with the token file: squid, secret, Compose variables.
2. Deploy the agent image. `LOYLEX_AGENT_PROVIDER` stays `codex`.
3. Canary chats through `LOYLEX_CLAUDE_CHAT_IDS`.
4. Switch to `claude`.

A thread always resumes on the provider that created it; only new threads follow
the setting. Rollback sets `codex` again; Claude threads keep resuming on Claude.
For a permanent rollback, revert this pin and rebuild.
