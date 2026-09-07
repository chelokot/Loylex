---
name: postfetch-warp
description: Download public media through @postfetch/core while routing both resolver and CDN requests through an existing Cloudflare WARP local proxy; use for YouTube and supported social URLs when direct fetch is blocked or must be selectively routed.
---

# PostFetch through WARP

Use this skill for public or user-authorized media only. It is not a method for bypassing
DRM, login walls, paywalls, or a platform's access controls. Treat `403`/`429` as a
service response: check the route once, honor `Retry-After`, and stop after a bounded
retry. Do not rotate a fleet of proxies to evade a limit.

## Proven PostFetch contract

The reviewed package is `@postfetch/core@0.9.2` (source commit `84bba65` in
`chelokot/postfetch`). Pin the version in an application and re-check the package and
source before upgrading it.

- `postfetch(url, options)` resolves a post to typed `items`; it does not download bytes.
- `download`, `downloadBlob`, `archive`, and `toResponse` materialize the result.
- Pass the same custom `fetch` to both `postfetch` and the materializer. Otherwise the
  resolver may use WARP while the CDN download goes direct.
- Pass the complete `MediaItem`, not only `item.url`: YouTube and Reddit can expose
  separate video and audio streams, which PostFetch merges in `download`/`downloadBlob`.
- Supported platforms in this version are Facebook, Instagram, LinkedIn, Pinterest,
  Reddit, SoundCloud, TikTok, X/Twitter, and YouTube.

## Establish and verify WARP

Use an already installed and authorized consumer WARP client. Keep its local listener on
loopback; never publish the proxy port. Command names vary by client version, so inspect
`warp-cli --help` before changing anything. Known current clients use:

```sh
warp-cli registration new       # first registration only
warp-cli mode proxy
warp-cli proxy port 40000
warp-cli connect
warp-cli status
```

Older clients use `set-mode proxy` and `set-proxy-port 40000`. Verify the actual listener
before invoking PostFetch:

```sh
curl --fail --socks5-hostname 127.0.0.1:40000 \
  https://www.cloudflare.com/cdn-cgi/trace
curl --fail --proxy http://127.0.0.1:40000 \
  https://www.cloudflare.com/cdn-cgi/trace
```

Use the protocol that succeeds and confirm the response contains `warp=on`. Bun's native
`fetch` proxy option supports HTTP/HTTPS proxy URLs, not SOCKS5; do not pass a
`socks5://` URL to Bun and assume it works. If WARP exposes only SOCKS5, use a
SOCKS5-capable fetch adapter or a local SOCKS5-to-HTTP bridge, then run the same trace
check through that adapter.

WARP is a routed Cloudflare egress, not a residential proxy, anonymity service, or
reliable country selector. Cloudflare's [WARP modes documentation](https://developers.cloudflare.com/warp-client/warp-modes/)
explicitly warns about the latter two limitations.

## Download from Bun

For the ready-made PostFetch CLI, the short path works when WARP accepts HTTP CONNECT:

```sh
HTTP_PROXY=http://127.0.0.1:40000 \
HTTPS_PROXY=http://127.0.0.1:40000 \
bun apps/cli/src/index.ts 'https://www.youtube.com/watch?v=VIDEO_ID' -o ./downloads
```

For library use, inject the proxy into every request and reuse that function for the
download. Bun's `proxy` option is documented in its [fetch proxy guide](https://bun.sh/guides/http/proxy):

```ts
import { archive, download, postfetch } from "@postfetch/core";

const proxy = process.env.PF_WARP_PROXY ?? "http://127.0.0.1:40000";
const fetchViaWarp: typeof fetch = (input, init = {}) =>
  globalThis.fetch(input, { ...init, proxy } as RequestInit);

const result = await postfetch(sourceUrl, {
  fetch: fetchViaWarp,
  preferredWidth: 720,
});

if (result.items.length === 0) {
  throw new Error("the post has no downloadable media");
}

if (result.items.length === 1) {
  const [item] = result.items;
  await Bun.write(`./downloads/${item.filename}`, await download(item, { fetch: fetchViaWarp }));
} else {
  const { bytes, filename } = await archive(result, { fetch: fetchViaWarp });
  await Bun.write(`./downloads/${filename}`, bytes);
}
```

Do not read a resolved YouTube `item.url` with a separate plain `fetch`: that can lose
the required headers and the separate audio stream.

## Troubleshooting order

1. Test the WARP trace through the exact proxy protocol and port.
2. Test one URL with `postfetch`; keep resolution and materialization on the same
   `fetchViaWarp` function.
3. If resolution succeeds but download fails, inspect `item.headers`, `item.audio`,
   and the CDN response status; do not silently fall back to a direct request.
4. On `429`, honor `Retry-After` and stop. On a bot/sign-in challenge, report the
   limitation instead of brute-forcing fingerprints or proxy rotation.

The PostFetch repository's offline suite is the cheap regression check:

```sh
bun test packages/core/test --timeout 30000
```

Run a live YouTube smoke test only deliberately and once, because it contacts the real
service: `POSTFETCH_LIVE=1 POSTFETCH_LIVE_PLATFORM=youtube bun test ...`.

References: [PostFetch core README](https://github.com/chelokot/postfetch/tree/main/packages/core),
[Cloudflare Linux setup](https://developers.cloudflare.com/warp-client/get-started/linux/),
and [Cloudflare WARP modes](https://developers.cloudflare.com/warp-client/warp-modes/).
