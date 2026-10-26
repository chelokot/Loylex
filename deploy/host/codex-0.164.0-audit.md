# Codex CLI 0.164.0 review

Reviewed 2026-10-26 for the operator's explicit request to update the official
Codex CLI and use GPT-6.1 Terra medium.

## Provenance and complete installed package

Old source: 0.159.2, `ff6aec96948b70d94983af2641a6b67c94faeff5`.
New source: official `openai/codex` tag `rust-v0.164.0`, resolving to
`6aaac694803004a63c6f393d153c96d22521a6b9`. Both npm artifacts' verified
SLSA attestations identify that commit, the official repository, and
`.github/workflows/rust-release.yml`, run
<https://github.com/openai/codex/actions/runs/39894017941/attempts/3>.
`npm audit signatures` verified two registry signatures and two attestations.
Archive bytes independently matched their npm SHA-512 SRI values.

| Artifact | SHA-256 |
| --- | --- |
| `@openai/codex@0.164.0` | `afb117ec0d382744583dd13154ba0ca6b0f1980f8ed6a23bffb3aaadb6226e30` |
| `@openai/codex@0.164.0-linux-x64` | `62659fefd9a8efa21a496402fde3c11c025bbeee735a582968f8ffd14cb5f79c` |

Installation remains build-time HTTPS fetch of those two exact archives, hash
verification, extraction to the existing global Node package paths, and a version
check. No package-manager install scripts run. The complete wrapper was read:
it locates the platform executable, detects package-manager ownership, passes
fixed argv/environment and forwards signals. It has no network fetch or dynamic
code import. Both package manifests have no install scripts or third-party npm
runtime dependencies. The native archive has 45 regular files, safe relative
paths, and no links. Reviewed the complete file inventory: CLI, code-mode host,
bwrap, ripgrep, voice runtime, manifests and licenses. Packaged zsh is removed.
All 38 voice-manifest file hashes matched. Voice source versions and source
checksums are identical to the previous installed release; advisory limitations
from the earlier review still apply. The CLI executable hash is
`b93f6811d3f653f0fb83be4050d857fb9abbb111dfa2ce160563327daff7f306`.

## Source, release path, dependencies and runtime boundary

Reviewed the release workflow diff, wrapper, Cargo lock version changes, daemon
settings/updater dispatch and the worker's actual app-server transport. The release
workflow keeps Cargo as the authoritative release path and adds separately named,
advisory Bazel artifacts. Actions are commit-pinned; the Rust toolchain changes
from 1.95.0 to 1.99.1. The npm provenance pins the selected artifacts independently
of mutable release URLs. New external lock versions include gix 0.89.0 and its
subcrates, V8 152.2.0, rustls 0.23.46, hyper 1.11.1, h2 0.4.19, curl 8.21.0,
and pinned git revisions for crossterm, MCP and Windows mxc. This is a substantial
upstream change; signature/provenance verification is not a claim of exhaustive
source auditing or reproducible-build verification.

OSV batch lookup of changed crates.io versions found GHSA-q54r-jf2p-rfr2 in
gix 0.89.0. Its documented exploit uses untrusted repository config to defeat
NTFS/HFS path protections on case-insensitive filesystems. The agent workspace
is Linux XFS, not either affected filesystem. Do not generalize this assessment
to Windows/macOS or mount a case-insensitive workspace without another review.
The upstream GitHub advisory list was also checked; the known sandbox path issue
must remain part of upstream release risk. No Cargo toolchain is installed here;
the full upstream Rust test suite was not run.

Correction to the initial blocked review: the script-fetching updater already
exists in 0.159.2. Its existence does not establish use by Loylex. In 0.164.0,
`cli/src/main.rs` dispatches plain `app-server --listen stdio://` directly to
`run_main_with_transport_options`; the daemon update/bootstrap branches require
separate subcommands. Managed-daemon mode defaults false and requires a Unix
socket. Loylex launches only private stdio app-server children, never daemon
bootstrap/start/update or `codex update`. Exec assessments also use a direct CLI
process. `check_for_update_on_startup=false` remains in the app-server argv and
persistent Codex config. No self-updater is invoked or enabled by this change;
updates continue through pinned, reviewed image builds. The daemon updater's
network-script execution remains an unused upstream capability, not an approved
Loylex update path. Do not invoke it.

## Validation, model availability and rollout

The extracted official 0.164.0 CLI completed an ephemeral read-only Sol low
request with `CODEX_UPDATE_OK`. The real Loylex stdio client completed an
isolated request with `APP_SERVER_UPDATE_OK`, including initialization, thread
start, turn events, final answer and process shutdown.

Terra medium was tested with this same new CLI and existing ChatGPT login.
The server returned HTTP 400 `model_not_found`: "The 'gpt-6.1-terra' model is not
supported when using Codex with a ChatGPT account." Model metadata was also
absent. Therefore the working Sol low configuration is retained; changing the
CLI does not grant server-side model availability. No credentials or account
mode were changed. Re-test exact `gpt-6.1-terra` / `medium` when availability
changes before switching production.

`bun run check` passed: typecheck, lint, 249 Bun tests and 40 Python tests.
Wait for the Images workflow for the exact
commit, then `loylex system deploy agent` and verify supervisor health. No host,
gateway, authentication, instruction, secret, sandbox/capability, health-check,
resource-limit, volume, queue or startup ordering configuration changes.
Blue/green rollout preserves the previous agent while the new one registers and
then drains existing work. Recovery is the prior pinned image through the host
supervisor; for a permanent rollback, revert this pin commit and rebuild. Codex
home, workspace and memory remain persistent.
