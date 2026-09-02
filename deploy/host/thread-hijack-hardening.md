# Thread-hijack and prompt-spoofing hardening

Reviewed: 2026-09-02

## Finding

The Telegram-trigger path selected a saved Codex thread from a replied-to bot message before
the worker knew who authored the new request. In a group, a different member could therefore
make Loylex resume another member's Codex transcript. Telegram history and forwarded or attached
text were also interpolated into the worker prompt without explicit data boundaries. Finally,
the worker and the `loylex` wrapper could execute TypeScript from the writable workspace, so a
prompt-driven workspace edit could replace the runtime used for control operations.

The text in the reported screenshot is not treated as authoritative evidence; these findings
were reproduced from the active gateway, worker, container, and deployment paths.

## Changes

- A saved Codex thread is resumed only when its first known Telegram owner matches the current
  transport-authenticated `message.from.id`. An unknown or different owner gets a fresh thread
  and full public context.
- Dynamic Telegram history, reply text, memory, and the current request are marked as untrusted
  data in the worker prompt, with an explicit end boundary. This is a model-facing defense; the
  database ownership check and image pinning are the enforcement boundaries.
- The worker entrypoint and `loylex` wrapper execute from root-owned `/opt/loylex/app`; the
  workspace is no longer the source of the running worker or control CLI.
- The worker compares workspace `AGENTS.md` with the image-pinned copy and refuses registration
  on mismatch or when the required immutable security clauses are absent.
- Agent root filesystems are read-only and `/tmp` is a `nodev,nosuid,noexec` tmpfs. Existing
  persistent volumes remain the recovery and data path.

No dependency or critical-version update is included. The image still arrives through the
reviewed, pinned main-branch build path; no runtime code download or shell-fed update mechanism
was added. The supervisor's blue-green rollout and inactive-slot rollback path remain the
recovery procedure.

## Verification and residual risk

`bun run typecheck`, `bun run lint`, `bun test`, and the Python unit-test suite pass, including
regression coverage for cross-user thread resumption, instruction integrity, prompt boundaries,
and read-only worker filesystems. Live host Podman behavior still requires the normal supervisor
health check during rollout.

The worker still has the existing bridge and supervisor capabilities because self-management is
part of the current design. A future defense-in-depth change should move supervisor authorization
out of the model-facing container and require a gateway-mediated, request-scoped operator
capability. This patch prevents the observed cross-user transcript leak and workspace-runtime
replacement but does not claim to make arbitrary model shell execution a separate security
principal.
