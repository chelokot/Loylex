# Codex CLI 0.159.2 due-diligence record

Reviewed: 2026-09-30

Decision: update the Loylex agent image from Codex CLI 0.157.1 to the stable
0.159.2 release. The worker will use the requested `gpt-6.1-sol` model with
`low` reasoning effort.

## Source and release provenance

- npm stable version observed: `@openai/codex@0.159.2`.
- Upstream source tag: [`rust-v0.159.2`](https://github.com/openai/codex/tree/rust-v0.159.2).
- Source commit resolved independently from GitHub: `ff6aec96948b70d94983af2641a6b67c94faeff5`.
- The npm SLSA provenance for both selected artifacts identifies the official
  `openai/codex` repository, `.github/workflows/rust-release.yml`, the tag, and
  that exact commit. The workflow run is
  [36642524844](https://github.com/openai/codex/actions/runs/36642524844).
- `npm audit signatures` verified two registry signatures and two attestations
  for the installed 0.159.2 wrapper and native Linux x64 package, with no
  invalid or missing attestations. Both downloaded archives
  independently matched the attested SHA-512 digests and npm SRI values below.
- The Git tag itself is not cryptographically signed; release provenance is
  instead pinned to the immutable commit by npm's verified attestation.

## Artifact pins and installation path

| Artifact | npm integrity (SHA-512) | Download SHA-256 |
| --- | --- | --- |
| `@openai/codex@0.159.2` wrapper | `sha512-SE13C3nZCYoVL569BdegoOl6vwjb7o2sXOo7ivwVzaVoY0cswwi0/6pIE0TyO/C0vIkQh3jslExitET7PBTfIg==` | `cf1e5d7b6e317a4a1d36dbff2ebd9b3cf048ac98d06fcb6682c57248e023cad2` |
| `@openai/codex@0.159.2-linux-x64` | `sha512-RrCZ1X52wpa1lOsXtCtSyhjOFdQPh7LH5Ccv8HsKmd/2UXbUwxXFqWXFK3JzatquUNGtW/TLox5Y7qVOGkV0/Q==` | `84a6b35fb45bdcb94cef9fcb329438045a8911f53876cc9a9a7e6f9bb1382eba` |

The agent image targets `linux/amd64`. Its build fetches these two exact npm
tarballs over HTTPS, checks the SHA-256 pins, extracts only into the reviewed
global package paths, and confirms `codex --version` matches the pin. The
wrapper and native package have no install scripts or third-party npm runtime
dependencies. The build removes the tarballs; it never installs or updates
Codex at runtime. This direct, verified extraction path was smoke-tested from
the same tarballs. The full npm audit reported zero vulnerabilities.

## Source and package review

- Compared the complete source change from 0.159.1 to 0.159.2: 47 files,
  387 insertions and 76 deletions. The only new dependency is a local
  `codex-utils-process` workspace crate; Cargo.lock has no third-party version
  changes. Its helper creates an ordinary `Command` on Linux, so the new
  process-call sites retain their Linux behavior. Windows-only changes suppress
  console creation for background children and add Windows regression tests.
- Reviewed the process-launch changes around Codex shell tools, hooks, Git,
  plugins, authentication helpers, and sandboxed execution. The code continues
  to pass executable arguments directly. Windows job assignment still happens
  before a contained child resumes; the existing fallback to an uncontained
  process on job failure remains. No authentication, permission, or Linux
  sandbox policy was changed by this release diff.
- The native archive contains 46 regular files with safe relative paths. It
  bundles the CLI, code-mode host, `bwrap`, ripgrep, zsh, and voice resources.
  All 38 hashes in the voice resource manifest matched the extracted files.
  The complete resource manifest pins each upstream source and digest. The
  voice runtime uses GLib 2.88.3 and GStreamer 1.28.6, with these seven
  GStreamer plugins: `app`, `audioconvert`, `audioresample`, `coreelements`,
  `opus`, `rtp`, and `rtpmanager`.
- GLib 2.88.3's upstream release notes include the fix for
  [CVE-2026-15588](https://gitlab.gnome.org/GNOME/glib/-/blob/2.88.3/NEWS), a
  GDBus pre-authentication denial of service. GStreamer 1.28.6 includes the
  fix for [SA-2026-0074](https://gstreamer.freedesktop.org/security/sa-2026-0074.html)
  and [SA-2026-0076](https://gstreamer.freedesktop.org/security/sa-2026-0076.html).
  The later 1.28.7 advisories cover the RTSP parser, FFmpeg plugin,
  `souphttpsrc`, and MP4/MOV demuxer; those components are absent from this
  package. The GStreamer project says its advisory list is not exhaustive, so
  the bundled voice runtime remains a residual risk and should be re-reviewed
  when upstream changes these pinned components. Loylex's text worker does
  not invoke Codex voice functionality.
- The upstream GitHub release workflow is unchanged from the reviewed 0.159.1
  source range. No runtime code download, shell-fed network response, dynamic
  import, or code evaluation was added.
- Existing persistent `config.toml` files are not rewritten. The worker passes
  model and reasoning effort as per-run CLI overrides, which take precedence
  over saved configuration per the official
  [Codex Developer Settings](https://learn.chatgpt.com/docs/developer-settings)
  guidance; the host's older model and effort defaults are migrated in
  `src/agent/config.ts`.

## Validation and rollback

- Tested the extracted 0.159.2 CLI with the current authenticated account in
  ephemeral, read-only mode. `gpt-6.1-sol` with `low` and
  `service_tier=priority` completed and returned `OK`.
- Official [GPT-6.1 Sol documentation](https://developers.openai.com/api/docs/models/gpt-6.1-sol)
  confirms `low` is a supported reasoning effort. The CLI 0.159.2 smoke also
  confirms access for this account.
- `bun run check` passed: typecheck, lint, 219 Bun tests, and 13 Python tests.
- The review container has no Cargo installation, so the upstream Rust suite and
  cargo advisory scan were not run locally. The release diff adds no third-party
  Rust dependency versions; the Linux process-helper implementation is unchanged
  behaviorally and the Codex package passed the authenticated smoke test.
- The image workflow and deployed runtime are verified as part of rollout.

To recover, use the supervisor's agent rollback to return to the prior pinned
agent image, then revert this commit and rebuild if a permanent rollback is
needed. The existing Codex home, workspace, and memory volumes are preserved.
