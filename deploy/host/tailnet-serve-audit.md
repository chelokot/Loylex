# Tailnet serve through the approval broker, 2026-11-12

Reviewed for the operator's request to control, through one approval per change, what the host
serves on its own Tailscale name. The container still has no Tailscale client, device, or
credential. Changes are proposed from the container and executed only after the operator presses
the button in Telegram.

## What changed

- `deploy/scripts/loylex_tailnet_policy.py` (new): the `tailnet` schema, file and size limits, the
  manifest that goes into the package, and the fixed review summary.
- `deploy/scripts/loylex_tailnet_serve.py` (new): the `tailscale` wrappers, publish, remove, status,
  the probe, the loopback site handler, and `tailnet_execute`.
- Small hooks in the infrastructure modules, each importing the tailnet modules lazily:
  - `loylex_approval_validation.py`: `tailnet` validation.
  - `loylex_approval_packages.py`: snapshot branch for `tailnet`; the two new names join
    `INFRASTRUCTURE_FILES`.
  - `loylex_approval_review.py`: tailnet packages get the fixed summary and never reach the reviewer
    model.
  - `loylex_approval_execution.py`: dispatch to `tailnet_execute` after the digest check.
  - `loylex_approvals.py`: read-only `tailnet-status` with no button; an opt-in loopback start that
    tolerates a missing module; the approval caption.
  - `loylex_supervisor_http.py`: production constructs `Approvals(..., loopback=True)`.
- Tests: `tests/tailnet_policy_test.py`, `tests/tailnet_serve_test.py`, `tests/tailnet_approval_test.py`,
  and the shared `tests/tailnet_fixtures.py`. `tests/t3_bootstrap_test.py` now checks the exact
  difference from the pre-T3 set, which is the two tailnet names, instead of frozen equality.
- `skills/tailnet-serve/`: the agent-facing skill and a request helper that mirrors the host limits.

The button-press authorization path (`callback`, the `OPERATOR_ID` check) and the
`message.from.id` path are unchanged.

## Host install (once, before the first tailnet request)

The two new modules are in `INFRASTRUCTURE_FILES`, but the one-click update installs only the
names in the package it was built from, which is the old set. The operator copies the two modules
once, from the approved commit, byte for byte:

```bash
for f in loylex_tailnet_policy.py loylex_tailnet_serve.py; do
  git show COMMIT:deploy/scripts/$f | sudo -u loylex tee /home/loylex/.local/bin/$f >/dev/null
  sudo -u loylex chmod 0755 /home/loylex/.local/bin/$f
done
sudo tailscale set --operator=loylex
```

Until the copy exists, tailnet requests fail with a missing-module error and the rest of the
approval broker still works. The copies must exist before the next infrastructure, gateway, or
host-config request, because those snapshots read every name in `INFRASTRUCTURE_FILES`.

The infrastructure request's package covers the ten files of the old set. The two new modules are
not in that package, so the operator reviews them through this document and the commit, not
through the package TLDR.

## Design

- **Operations.** `tailnet` with `action` `publish` (name and base64 files, `index.html` required)
  or `remove` (name only). Each needs one operator button press. `tailnet-status` is read-only and
  reports the host DNS name, the routes, and the site names.
- **Name and files.** Names match `[a-z][a-z0-9-]{1,39}`. File paths match a relative pattern with
  no `.` or `..` segments and at most four levels. Suffixes are allowlisted. Limits: 200 files,
  2 MiB per file, 4 MiB total.
- **Storage.** `~/.local/state/loylex-tailnet/sites/<name>/`, written to a staging directory and
  swapped in with `os.replace`. The previous version is kept until the new one passes its checks.
- **Route.** `tailscale serve --bg --https=443 --set-path=/<name> http://127.0.0.1:8792/<name>` for
  new routes only. Routes that point at another target are never replaced, and a text cross-check
  refuses names the JSON parse does not show. Removal uses `serve --https=443 --set-path=/<name> off`.
  `serve reset` and `funnel` are never used.
- **Loopback server.** `127.0.0.1:8792` only; 8787, 8790, 8791, 8192, and 10000 are already taken. It serves files inside `sites/<name>/`, rejects
  `.`, `..`, encoded separators and symlinks that leave the site, has no directory listing, and
  answers GET and HEAD only.
- **Probe.** After the route is recorded, the host fetches `https://<dnsName>/<name>/` from its
  own tailnet IPv4 address and requires HTTP 200 and the first bytes of `index.html`. On failure it
  removes the new route and restores the previous files.
- **Concurrency.** Execution runs under the existing `execution_lock`.
- **Module boundaries.** Tailnet code lives in its own modules because the approval modules must
  stay under the 5000-token file limit. The one-click update does not copy those modules, so
  the host copy above is the install path.
- **Binary.** `/usr/bin/tailscale` is fixed, the argument lists are fixed, and no shell is used.
  The environment is `PATH=/usr/bin:/bin`.

## Tailscale facts checked (public docs, 2026-11-12)

- The Serve CLI reference (last validated 2026-01-26) documents `--https=<port>`, `--set-path`,
  `off` to remove a single route, and `serve status [--json]`.
- The Serve feature page (last validated 2026-01-20) says serving a file, directory, or Unix socket
  requires root, while forwarding a port does not. This is why the design proxies to a
  loopback server instead of serving a directory with tailscale.
- The same page says the CLI changed in 1.52. The host version is not yet known; see below.

## Not verified (must be checked on the first real publish)

- How `--set-path` maps the request path to the proxy target. The target includes the site name
  (`.../<name>`), so the site works whether the mount prefix is stripped or kept. If Tailscale
  duplicates the prefix, the probe fails, the publish rolls back, and the handler must change.
- The `serve status --json` schema. The parser reads `Web` then `Handlers` then `Proxy` or `Path`.
  The text cross-check refuses a route the parser does not see.
- `tailscale status --json` fields `Self.DNSName` and `Self.TailscaleIPs`.
- The host's Tailscale version and whether the supervisor user can run serve. The host must run
  `sudo tailscale set --operator=loylex` once, enable HTTPS in the tailnet admin, and report
  `tailscale version`.

## Residual risks

- Site content is visible to every tailnet member who can reach the host. Serve is tailnet-only
  and Funnel is never enabled, but other tailnet members can see the sites.
- All sites share one origin (`host:443`). A site's JavaScript can read another site's same-origin
  storage. Sites are agent-authored and each publish needs an operator button press, but this is
  still a real limit.
- The loopback port is reachable by any local process on the host. It serves only site files.
- A compromised agent could propose publish requests. Each one still needs a button press. Status
  is read-only and reveals only the DNS name, routes, and site names.
- Route targets are checked against exact strings, so a manual change by the host operator is
  treated as foreign and refused until resolved by hand.

## Rollback

- Remove one site: approve a `remove` request for its name.
- Remove the route by hand on the host: `tailscale serve --https=443 --set-path=/<name> off`, then
  delete `~/.local/state/loylex-tailnet/sites/<name>`.
- Revert the code: revert this commit and approve the infrastructure update for the reverted commit.
  Routes created earlier stay until removed with the commands above.

## Evidence

- `python3 -B -m unittest discover tests -p '*_test.py'`: all 114 tests pass, including the 16 new
  tailnet tests (fake tailscale, loopback handler, rollback, snapshot regression, and the broker
  path with the operator button and a refused non-operator button).
- `request.py` output passes `validate_tailnet` for a sample site; hidden directories are skipped.
- Not yet run on the host. The first real publish is the verification step for the unverified
  items above.
