# Codex CLI 0.172.0 and GPT-6.2 Sol low

Reviewed 2026-11-24 for the operator's explicit update and model-switch request.
The installed 0.164.0 CLI rejects gpt-6.2-sol with model_not_found; the same
ChatGPT account succeeds with the official 0.172.0 CLI. This is a client version
compatibility issue, not evidence that the account lacks model access.

## Provenance and installation

Old source: 0.164.0, 6aaac694803004a63c6f393d153c96d22521a6b9.
New source: official openai/codex rust-v0.172.0, annotated tag
fc3036dba44468096953f0e832f3fecd3adc0228, source commit
3d86e43b075adeba2193ec5c22ac92f55afd82e6. Both npm SLSA attestations
identify that commit and .github/workflows/rust-release.yml, run
https://github.com/openai/codex/actions/runs/45283186819/attempts/1 .
`npm audit signatures` verified both registry signatures and both attestations.
Downloaded archives independently matched npm SHA-512 integrity metadata.

| Artifact | SHA-256 |
| --- | --- |
| @openai/codex@0.172.0 | 40777b4155e19f2625bc39a74a94d7d24f84efe006dbdcc4a83fab25de8d7e79 |
| @openai/codex@0.172.0-linux-x64 | 48a5ee5dba98c7745a48b8d72af84f91880fec5856269627328fd564f60d41a7 |

Installation retains exact build-time HTTPS URLs, archive hash checks, extraction
into the existing global package paths, and a version assertion. No install
scripts execute. Both package manifests have no install scripts or third-party
npm runtime dependencies. Read the complete JS wrapper: it resolves a local
platform executable, detects package ownership, passes fixed argv/environment,
and forwards signals (or uses execve). It does not fetch or execute network code.
The complete native inventory has 45 regular files and no links or unsafe archive
paths: CLI, code-mode host, bwrap, ripgrep, voice runtime, manifests and licenses.
All 38 voice-manifest hashes match, including the CLI executable
ad83b94c093f0cdd8176a6bc8005a461bdf23a759863e157d40f562b8a9d664d.

## Source and dependency review

Read release notes, release workflow diff, installed wrapper and manifests,
CLI app-server dispatch, and registry dependency changes in Cargo.lock. The
release workflow adds optional Bazel release selection and a packaged exec-server
in upstream release bundles; the selected npm inventory above remains explicit.
The plain stdio app-server branch still directly calls
run_main_with_transport_options. Managed daemon bootstrap/update are separate
subcommands, and are never invoked by Loylex. Startup version checks remain
disabled. This does not approve the upstream daemon updater or remote control.

OSV batch checked the 39 changed crates.io package versions. It reports
RUSTSEC-2026-0596 in etherparse 0.21.0 (lax IPv6 extension iteration), and
RUSTSEC-2026-0574 through -0582 in heapless 0.9.3. The only direct etherparse
usage in Codex is linux-sandbox/managed_tcp_stack.rs, which uses strict
IpSlice::from_slice, not the affected lax parser. Heapless 0.9.3 enters through
smoltcp 0.14.0 in that same managed TUN sandbox stack. Loylex runs its private
app-server with danger-full-access inside its existing container, so it does not
instantiate the managed TUN sandbox. Do not assume this assessment covers that
sandbox mode. This is a scoped operational review, not an exhaustive audit or
reproducible build; upstream Rust tests were not run locally.

## Validation, rollout and recovery

The extracted CLI completed a read-only ephemeral gpt-6.2-sol / low request with
CODEX_62_OK. The actual Loylex runCodexAppServer client completed a separate
request with APP_SERVER_62_OK, including handshake, thread/start, turn/start,
streamed result and process shutdown. Repository checks must pass before push.

Change the pinned agent build, default model, and both declared Compose model
settings from gpt-6.1-sol to gpt-6.2-sol; reasoning stays low. Host Compose needs
the existing host-config approval broker, after the agent image publishes.
Deploy the pushed agent image using loylex system deploy agent and verify its
health. Apply host configuration only through the operator's commit-specific
button, then verify a real resumed Telegram turn uses the selected model.

No identity, authorization, credentials, gateway, instructions, volumes, health
checks, limits, startup ordering or container capabilities change. Blue/green
rollout retains recovery to the prior agent image; permanent rollback reverts
this pin and model change and rebuilds. Persistent workspace, memory and Codex
session storage are retained.
