const shellNames = new Set(["bash", "dash", "fish", "ksh", "sh", "zsh"]);

type Quote = "double" | "single" | null;

function shellWords(value: string): string[] | null {
  const words: string[] = [];
  let current = "";
  let quote: Quote = null;
  let escaped = false;
  let tokenStarted = false;

  for (const character of value) {
    if (escaped) {
      current += character;
      escaped = false;
      tokenStarted = true;
      continue;
    }
    if (quote === "single") {
      if (character === "'") {
        quote = null;
      } else {
        current += character;
      }
      tokenStarted = true;
      continue;
    }
    if (quote === "double") {
      if (character === '"') {
        quote = null;
      } else if (character === "\\") {
        escaped = true;
      } else {
        current += character;
      }
      tokenStarted = true;
      continue;
    }
    if (character === "\\") {
      escaped = true;
      tokenStarted = true;
    } else if (character === "'") {
      quote = "single";
      tokenStarted = true;
    } else if (character === '"') {
      quote = "double";
      tokenStarted = true;
    } else if (/\s/u.test(character)) {
      if (tokenStarted) {
        words.push(current);
        current = "";
        tokenStarted = false;
      }
    } else {
      current += character;
      tokenStarted = true;
    }
  }

  if (quote !== null || escaped) {
    return null;
  }
  if (tokenStarted) {
    words.push(current);
  }
  return words;
}

function basename(path: string): string {
  return path.slice(path.lastIndexOf("/") + 1);
}

function isCommandOption(value: string): boolean {
  return value === "--command" || /^-[^-]*c$/u.test(value);
}

/**
 * Codex's terminal bridge may report the launcher instead of the command body,
 * for example `/bin/bash -lc 'rg -n foo src'`. Keep only the body for the
 * user-facing progress history. Unknown or malformed forms are preserved.
 */
export function visibleTerminalCommand(command: string): string {
  const original = command.trim();
  const words = shellWords(original);
  if (!words || words.length < 3 || !shellNames.has(basename(words[0] ?? ""))) {
    return original;
  }

  for (let index = 1; index < words.length; index += 1) {
    const option = words[index];
    if (option === "--") {
      break;
    }
    if (!option || !isCommandOption(option)) {
      continue;
    }
    const body = words[index + 1]?.trim();
    return body || original;
  }
  return original;
}
