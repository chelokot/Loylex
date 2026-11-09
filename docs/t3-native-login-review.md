# Native T3 Connect enrollment review — 2026-11-09

The previous implementation required a public HTTPS callback that the operator
had never provisioned. That made the promised easy sign-in unusable. This change
removes the callback listener, config requirement and public-domain prerequisite.
No gateway/supervisor authentication extraction, operator callback check, standing
instruction, inbound audit or canonical remote is changed.

## Protocol and provenance

Official source: `pingdotgg/t3code` commit
`2b65ffb641f152fadf443096bad7f4a0677caae4`, the same immutable protocol baseline
as the prior review. The operator screenshot reports desktop
`0.1.8-nightly.20261107.4340`; artifact provenance/compatibility still needs the
live enrollment check. No T3 executable, SDK or dependency is installed/vendored.
No runtime executable/code download, update mechanism or dynamic import is added.

Inspected source and SHA-256:

| Source | SHA-256 |
| --- | --- |
| `apps/server/src/cloud/CliTokenManager.ts` | `23c345645f9e2cf90e4a83c4a592980127056dd766281800d29213bcf2b3a2ae` |
| `apps/server/src/cloud/publicConfig.ts` | `2d38d9d05a4d8f17f226ecfdda68ef2fd252e54559a7d09c33acdb801a43c0ba` |
| `apps/server/src/auth/http.ts` | `4add15463e63e6673f54bb2856fa69b25a19dfe8c564d18526fc79e00d3df93e` |
| `apps/server/src/auth/McpOAuth.ts` | `a08c370025d8423380819ed30e7ece5a97f135a69d7429b98b2caac390a1afcb` |
| `apps/server/src/auth/EnvironmentAuth.ts` | `8a2e41dd45597b8d2b8ba728015eebd08ffabf7630a49d47616371a533ba0c38` |
| `packages/contracts/src/auth.ts` | `afede6403875da53c432f92f947d38a074404553859c95bab2785c57d69a7b5e` |
| `packages/contracts/src/relay.ts` | `94ff0570c801adf8fe72ecf17f812e19d8100acc8aa13eece8c44c7265f5ce3b` |
| `packages/contracts/src/environmentHttp.ts` | `1f9414c5c85a9d27a8dcf3ff0cffd20f60152bc623d0f3865df2dbcde67f7ec6` |

Also inspected official hosted public application assets without executing them,
to identify the public CLI OAuth client ID `hzxSgY2cH10sDU2r`, issuer
`https://clerk.t3.codes` and relay `https://relay.t3.codes`. These constants are
pinned in reviewed source; they are not fetched from JavaScript at runtime.
`https://clerk.t3.codes/.well-known/openid-configuration` independently confirmed
that issuer, `/oauth/device_authorization`, `/oauth/token`, `/oauth/userinfo` and
support for the RFC 8628 device grant. Public application bundle hashes identify
the exact inspected metadata artifacts, not a signature/build provenance claim:

- `public-0.js`: `ff242c5a6a04277c5edd2b22379afc50618f406cfaa4a7092adfecd933864e3e`
- `hosted-public-config.js`: `ad4cf49d4ae8a31831c60ed1fea3c95bb2c7d91971e8f095f0102df314a37611`

The upstream CLI uses this device grant. Its account token is not an MCP token;
MCP accepts only a dedicated MCP-client grant. A T3 Connect bootstrap credential
is proof-bound and must not be downgraded into a browser cookie or MCP bearer.
The bridge therefore uses the ordinary authorized delegation API after an
explicit second live operator approval, not reinterpretation of token audiences.

## User and credential flow

1. The operator approves starting device sign-in for an exact computer name or
   MCP endpoint. The host posts the issuer's verification link and public user
   code. The secret device code is host worker memory only. The code is polled
   for at most ten minutes; only authorization_pending/slow_down continue polling.
2. After human sign-in, fixed-issuer userinfo supplies account subject/email, and
   the relay supplies the owned environment list. Exactly one matching computer
   is required; duplicate names, missing targets and invalid public endpoints fail.
   No remote session or MCP permission is created at this point.
3. A separate immutable approval presents the authenticated account email,
   computer label, environment ID and exact HTTPS endpoint. This prevents a
   different participant who opens the group sign-in link from silently enrolling
   their own same-named computer. The live Telegram operator must check the target.
4. Only that second approval consumes the host memory account token and starts
   enrollment. It revalidates the endpoint and environment ID. A WebCrypto P-256
   key binds the relay access token, relay bootstrap and environment access token
   through ES256 DPoP proofs (htu, htm, iat, jti and ath; nonce when challenged).
5. The environment token requests only the four MCP full-access scopes plus
   access:write for enrollment. The existing /api/auth/pairing-token endpoint
   checks access:write and scope delegation, creating a one-use pairing credential
   restricted to the four MCP scopes. The normal /oauth/mcp/decision pairing-code
   path consumes that credential, respecting managed policy. PKCE S256 and exact
   issuer/state/return-URI checks protect code exchange. No browser callback URL
   is visited; its fixed loopback return URI is only the OAuth binding identifier.
6. Only the final, narrow MCP bearer is saved in the existing host mode-0600
   credential store. Account tokens, proof-bound tokens, pairing/authorization
   codes and proof keys never enter agent results, approval packages or Telegram.
   The temporary account token is removed from memory before enrollment starts,
   or expires after ten minutes, with no refresh token persisted/requested.

Account subject/email identify a T3 credential only. They never redefine the
Telegram operator, repair Telegram sender metadata or authorize an operation.
Task launches, messages, reads, stops and project registration still need their
existing per-operation live operator approval. Free status remains a positive
metadata allowlist. Full-access tasks are autonomous, not filesystem sandboxes.

Restart loses temporary in-memory login state and requires a new login. Saved
metadata contains no credential. Replacement, disconnect, changed configuration,
expiry and consumed confirmation fail closed. A confirmed mutation with an
unknown outcome is never replayed. A failed or narrowed grant is not downgraded.

## Cryptography and execution path

There is no new dependency/version/image pin. Existing Bun 1.4.0 WebCrypto supplies
P-256 generation and ECDSA signing, avoiding handwritten elliptic-curve or ASN.1
cryptography. The host reads the already installed gateway container's immutable
local image ID and runs only the fixed reviewed `T3_CRYPTO_SCRIPT` with that image.
The image is never pulled by the helper. No external T3 source or hosted asset is
copied/imported into an image. The gateway and operator authentication code are
unchanged; there is no execution inside the running gateway.

The crypto helper has no network, secrets, host mounts or inherited token
arguments. It uses a read-only filesystem, nobody UID/GID, cap-drop ALL,
no-new-privileges, 128 MiB, 0.5 CPU, 32 PIDs, bounded tmpfs and a 20-second container
lifetime. `--log-driver=none` prevents stdout keys entering Podman logs. Generated
proof keys pass through private host stdin/stdout only; account/MCP tokens never
go into the helper. Fixed source is the only evaluator input; JSON messages are
inert stdin data, not shell or executable instructions. The complete helper source
and all changed Python/TypeScript modules are reviewed; no bundled executable or
minified dependency is shipped.

The HTTP client pins public DNS/TLS per connection, follows no redirects and
bounds bodies. Only a definitive 401 DPoP nonce challenge may reissue a request,
with a fresh proof, after authentication failed before handler execution. No
transport/5xx retry of enrollment occurs. Errors contain fixed local stage labels,
never provider response bodies or credentials. There are two sign-in worker slots
and at most twenty temporary account contexts. Existing broker queue/disk/expiry
limits and token storage leases remain.

## Validation, rollout and recovery

Tests cover real live-button broker state transitions for both approvals,
no public callback dependency, link allowlisting, secret non-disclosure, unique
computer selection, authenticated account metadata, pending/slow_down polling,
changed leases, concurrent confirmation/unknown outcome single use, proof-bound
native enrollment and narrow MCP exchange, PKCE and exact endpoint/ID checks,
real Bun WebCrypto signature verification, and networkless/logless helper flags.
The existing exact pre-T3 installer file-set import test still passes: no new host
installation path is introduced. Full repository checks and diff checks run before
push. Live helper isolation, issuer login, native grant compatibility, revocation
and restart still need the operator's actual login; mocks cannot establish those.

Deploy through the saved-commit infrastructure approval and publish/deploy the
agent image. The gateway needs no update. Re-run the requested laptop-fedora
connection and verify the returned device sign-in link. After the operator logs
in, verify the second target approval, harmless task, free status and approved
result read on the actual laptop.

Rollback restores the previous reviewed host modules through host maintenance,
keeping registry, credentials, audit and history. Existing MCP registrations remain
compatible. Stop remote tasks before revoking their T3 grant; discard/restart an
unfinished login rather than replaying its enrollment. No public DNS, TLS proxy,
firewall rule or listening port is added, so none needs rollback. Source recovery
is an ordinary revert. The old unused t3-oauth.json, if any, is preserved and no
longer read; existing credentials are not deleted.

Final local validation: `bun run check` passed: typecheck, Biome, 263 TypeScript
and 84 Python tests (including real local Bun signature verification).
`git diff --check` passed. No change to AGENTS.md, gateway auth extraction,
operator callback checks or inbound auditing. Actual device login and isolated
host crypto execution remain rollout checks, not proven by mocked protocol tests.
