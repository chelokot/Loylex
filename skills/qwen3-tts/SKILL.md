---
name: qwen3-tts
description: Generate short, natural voice clips locally with Qwen3-TTS 1.7B CustomVoice, especially for emotional English phrases and Telegram voice delivery.
---

# Qwen3 TTS

Use `Qwen/Qwen3-TTS-12Hz-1.7B-CustomVoice` for new local speech generation. Do not
reuse an existing clip and change only its speed, pitch, or volume when the user asks
for a different delivery; regenerate from the text.

## Proven local setup

Keep the virtual environment, Hugging Face cache, and model files in a temporary
directory outside the repository. A known-working CPU setup is:

```bash
python3 -m venv "$tts_tmp/venv"
"$tts_tmp/venv/bin/pip" install --index-url https://download.pytorch.org/whl/cpu \
  'torch==2.14.0+cpu' 'torchaudio==2.11.0+cpu'
"$tts_tmp/venv/bin/pip" install --no-cache-dir 'qwen-tts==0.1.1' soundfile
```

Load the model on a CPU-only machine with `device_map="cpu"`,
`dtype=torch.bfloat16`, and `attn_implementation="sdpa"`. Set `HF_HOME` to the
temporary directory so the multi-gigabyte cache can be removed after delivery.

For English, call `generate_custom_voice` with `language="English"` and a built-in
English speaker. `Ryan` is a good starting point for dynamic reactions; `Aiden` is a
warmer alternative. The 1.7B model supports `instruct`, so describe the intended
prosody explicitly (for example: warm, spontaneous, lightly excited, clear words,
no monotone and no elongated vowels). Good starting generation settings are
`do_sample=True`, `top_p=0.95`, `temperature=0.85`, and
`repetition_penalty=1.05`; adjust the instruction or speaker before trying time
stretching.

Write the returned waveform with its returned sample rate. For Telegram voice
delivery, convert the fresh output to OGG/Opus and follow
[`skills/telegram/SKILL.md`](../telegram/SKILL.md), using `loylex upload-voice` for
an actual voice message. Verify duration and codec, upload once successfully, then
remove the temporary environment/cache.
