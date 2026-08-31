# Vendored Telegram API bundle

This directory contains the byte-for-byte `mod.mjs` artifact from
<https://github.com/ExposedCat/autoupdate-typescript-telegram-bot-api> at commit
`e656be5ab007fe552faae04b6ce07cccdd9d89c3`.

The artifact SHA-256 is:

```text
f0c491bec712eca09b96b1827c8800b46bdbe241be5fec02d4ef18bbe0d7cced
```

The upstream `LICENSE` is MIT. Loylex imports only `Api` and `InputFile`: the gateway owns its
polling loop, and therefore does not instantiate the bundle's higher-level `Bot` class.
