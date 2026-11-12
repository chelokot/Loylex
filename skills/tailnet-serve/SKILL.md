---
name: tailnet-serve
description: Publish, remove, or list static sites on the host's Tailscale name (tailnet-only, HTTPS) through one operator button press per change; use when asked to host or manage what is served on the VPS tailnet domain.
---

# Tailnet hosting

The host serves approved static sites at `https://<host dnsName>/<name>/`. Only tailnet members can open them. Funnel (public internet) is never used, and no other route is touched.

The container has no Tailscale client and no tailnet credentials. Everything goes through the approval broker, and only the operator's live button press executes a change.

## Read status (no button)

Write `{"jobId": JOB, "operation": {"kind": "tailnet-status"}}` to a file and run `loylex approve submit FILE`. The reply lists `dnsName`, `routes` (path to target), and `sites`.

## Publish a site (one button per publish)

```bash
python3 -I /workspace/Loylex/skills/tailnet-serve/request.py publish --job JOB --name NAME --dir SITE_DIR --out /workspace/tmp/tailnet-request.json
loylex approve submit /workspace/tmp/tailnet-request.json
loylex approve status APPROVAL_ID
```

- The helper reads the directory, skips hidden entries, and refuses symlinks and disallowed files before submitting.
- Required: `index.html` at the root. Name: `[a-z][a-z0-9-]{1,39}`. Limits: 200 files, 2 MiB per file, 4 MiB total. Allowed suffixes: html, css, js, mjs, json, svg, png, jpg, jpeg, gif, webp, ico, txt, woff, woff2.
- The Telegram package holds the exact file bytes. Its TLDR is a fixed summary; the bytes are not sent to a reviewer model.
- Publishing the same name replaces its files. A name whose path already points at another target is refused.
- After the button press, the host publishes, checks the route, and fetches the URL from its own tailnet address. If anything fails, it rolls back the route and the files, then reports the first failing step.

## Remove a site (one button per removal)

Use the helper's `remove --job JOB --name NAME --out FILE` mode, then submit the same way. It removes only the `/<name>` route and that site's directory.

## Host prerequisites (operator, once)

The host reports these as errors when they are missing:

- `sudo tailscale set --operator=loylex` so the supervisor user may manage serve.
- HTTPS certificates enabled in the tailnet admin console. When `serve` prints a consent URL, the operator opens it.

## Rules

- Never ask for, print, or store Tailscale keys or any tailnet secret in chat; the chat is archived.
- Never run `tailscale` from the container; the binary is absent there.
- Do not publish anything the operator has not asked for. Each change must be a separate approval.
- Record the returned URL for the operator. Say it is visible to tailnet members only.

See `deploy/host/tailnet-serve-audit.md` for the design, the checked Tailscale facts, and the unverified items.
