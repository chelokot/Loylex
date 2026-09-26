# Codex CLI 0.157.1 due-diligence record

Reviewed: 2026-09-26

Decision: approve the stable `@openai/codex` `0.157.1` release for the Loylex
agent image. The previous image bundled `0.151.0`. The `0.157.1` CLI is the
first tested version in this update that advertises and successfully runs
`gpt-6-luna` through the worker's existing ChatGPT authentication.

## Candidate and artifact pins

- Stable npm tag: `latest -> 0.157.1`
- Alpha tag observed during review: `0.159.0-alpha.4`; not selected for production.
- Upstream source tag: [`rust-v0.157.1`](https://github.com/openai/codex/tree/rust-v0.157.1)
- Resolved upstream source commit: `36650394c5b38c2990ccf2a3457165ca3e9d9726`
- Wrapper package: [`@openai/codex@0.157.1`](https://www.npmjs.com/package/@openai/codex/v/0.157.1)
- Linux native package: `@openai/codex@0.157.1-linux-x64`
- Wrapper npm integrity: `sha512-qJ/UZ0bmYP+/Umav1L9WpmtMYeA6q1+4r4qILSYOKQZhP7WRdjyTQWz3O0dTImZ9RT7AazZa85D87xRDHogcHw==`
- Linux native npm integrity: `sha512-Eac8XlC0nCXSeUjDU9l8yLJ6P9evv1mO+AnvILoNwlegBC7B3AVXqJ05QcMhQX7RcJ3Lk2618ykCb2X2ui8VAQ==`
- Downloaded wrapper tarball SHA-256: `813e2a944f4474b7e1826d9ce8bf696ad8d80c68f43f7a7067beec51fa8f5b73`
- Downloaded Linux native tarball SHA-256: `7f12677740f439fe4884c7031d9d703e571cecf5ea9fa3a05abd1bbccc2162a8`

The image build installs the exact version at build time with npm and never
downloads Codex executable code at runtime. The wrapper package has no install
scripts and its native-package mapping remains the expected platform-specific
optional dependency path.

## Review and verification

- Compared the `0.151.0` and `0.157.1` wrapper and native package manifests and
  inspected the complete final tarball contents.
- The wrapper change is package-manager detection/upgrade guidance; the native
  metadata changes only its version. The new native bundle adds the upstream
  voice host/resources and does not alter Loylex's invocation boundary.
- Confirmed both npm integrity values independently from the downloaded
  tarballs. The source tag resolves to the recorded commit.
- Installed `0.157.1` in a disposable directory and verified `codex --version`,
  the stable Fast feature, the model catalog, and a live `gpt-5.6-luna` smoke
  request with `service_tier=priority`.
- Verified a live `gpt-6-luna` smoke request with the same current ChatGPT
  authentication; it completed successfully with `service_tier=priority`.
- Added a narrowly scoped runtime migration for the previous temporary
  `gpt-5.6-luna` host Compose pin. This is needed because the supervisor pins
  image digests but does not rewrite the host-managed Compose environment on
  every repository push; all other explicit model values remain untouched.
- Ran the Loylex check suite: 214 Bun tests and 13 Python tests passed.

## Residual risk and rollback

The native Codex executable is a prebuilt upstream artifact rather than an
independently reproducible local build. npm integrity checks protect the
reviewed downloads from substitution, while the source tag and commit provide
provenance; the upstream build environment remains a residual trust boundary.
The new voice resources increase the Linux package size, but the worker does
not invoke voice functionality.

To roll back, restore the previous reviewed image commit with
`CODEX_VERSION=0.151.0` and the prior runtime model pin, rebuild the agent
image, and use the supervisor's blue-green rollback/deploy procedure. The
existing Codex home volume and thread transcripts are preserved.
