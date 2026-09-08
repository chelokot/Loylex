---
name: telegram
description: Search Loylex's Telegram archive and send, delete, download, or upload Telegram content through the secret-isolating gateway.
---

# Telegram gateway

Use the `loylex` command. The gateway owns the bot token; never seek or recreate it.

- `loylex status` reports archive and queue counts.
- `loylex usage [CHAT_ID] [LIMIT]` returns JSON token analytics grouped by users, Telegram
  topics, Codex threads, and day; use it as the data source for charts.
- `loylex search 'FTS QUERY' [CHAT_ID]` searches archived message text with SQLite
  FTS5 syntax.
- `loylex query 'SELECT ...' '[PARAMS_JSON]' [MAX_ROWS]` runs a parameterized read-only SQL
  query through the gateway and returns `columns`, `rows`, and `truncated`.
- `loylex media FILE_ID OUTPUT_PATH` downloads Telegram media without exposing the
  bot token.

## Evidence gate for image-specific searches

When a user asks for a particular meme, screenshot, or other image, treat text matches,
captions, sender/date, forwarding metadata, and image dimensions as candidate evidence only.
Report an exact match only after downloading the live media with `loylex media` and checking
the image contents (visually or with OCR as appropriate). Inspect every item in a media group
when the request could refer to any of them.

An old `telegram_export` placeholder such as `File not included` cannot verify the image.
Keep it explicitly labeled as an unconfirmed candidate and request a fresh forward or upload
if exact identification is required; never present it as the found image.

- `loylex send CHAT_ID 'RICH MARKDOWN'` sends to a chat already present in the
  archive.
- `loylex delete CHAT_ID MESSAGE_ID` asks Telegram to delete one live message in a chat
  already present in the archive. It does not remove the archived copy.
- `loylex upload CHAT_ID FILE [CAPTION]` uploads a local file; static files go as documents,
  while a `.gif` is automatically sent as a Telegram animation.
- `loylex upload-animation CHAT_ID FILE [CAPTION]` sends a GIF or silent H.264/MPEG-4 animation
  through Telegram's `sendAnimation` method. Use this for GIFs instead of forcing them through
  `sendDocument`; GIFs are normalized to silent H.264/MPEG-4 before upload for reliable Telegram
  previews, so a GIF may arrive as an MP4 animation. Animation uploads are limited to 50 MB by
  the Bot API.
- `loylex upload-voice CHAT_ID FILE [CAPTION]` uploads a local OGG/Opus file as a Telegram
  voice message.

## Reliable animation delivery

Treat transport success and a usable Telegram preview as separate outcomes. For a GIF, use
`loylex upload-animation` (or the generic `loylex upload`, which routes `.gif` files there),
wait for exit code 0, and do not upload the same successful result twice. The upload path
normalizes GIFs to a silent H.264/MPEG-4 animation so Telegram can build a visible preview;
the result may therefore arrive as MP4.

If a user reports a black, static, or otherwise broken animation, inspect the actual source
and reproduce the failure boundary. Then send one corrected animation and verify its codec,
dimensions, duration, and successful gateway response before reporting completion. If the
failure reveals a missing reusable capability, fix the upload path and its instructions/tests,
push and deploy the fix according to the repository workflow, and complete the original
delivery in the same task rather than stopping at a diagnosis.

The runtime automatically delivers the final Codex response to the current request. Do not
call `loylex send` for that ordinary response. Use it only when the task explicitly requires
a separate proactive message or another destination.

`loylex query` never mounts or exposes the SQLite file to the agent. The gateway executes the
statement on a separate SQLite read-only connection; only one `SELECT`, `VALUES`, read-only
`WITH`, or read-only `EXPLAIN` statement is accepted. Writes, transactions, `PRAGMA`, `ATTACH`,
and multiple statements are rejected. Results are capped at 10,000 rows and 8 MB, so a
`truncated: true` response must be paginated before claiming completeness. Use parameter
placeholders instead of interpolating Telegram text. For example:

```bash
loylex query \
  'SELECT message_id, date, text FROM messages WHERE chat_id = ? AND text LIKE ? ORDER BY date ASC, message_id ASC LIMIT 100' \
  '[-1001756869879,"%лейло%"]' \
  100
```

Use `loylex query` for chronological or aggregate work and inspect `sqlite_master` when the
schema is needed; `loylex search` is intentionally a small, relevance-ranked FTS shortcut.

Rich Markdown supports GitHub-flavored Markdown, tables, `$$LaTeX$$`, arbitrary
supported Rich HTML, `<details>`, `<tg-collage>`,
`<tg-slideshow>`, and media URLs. Keep a rich message within 32,768 UTF-8
characters and 500 blocks.

Use `$$...$$` to render LaTeX in Telegram. A fenced `latex` code block displays
the source instead of rendering it, so use one only when the user explicitly asks
for raw LaTeX code.

Use current-request metadata for chat and message IDs. Do not guess a destination chat. Search
results are private chat data: quote or forward only when the user's request authorizes it.
Only use `loylex delete` when the current request explicitly asks to remove that message; Telegram
still enforces the bot's deletion permissions and message-age limits.
