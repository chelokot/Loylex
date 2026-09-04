import { formatTelegramLinks, parseTelegramLinks } from "./parser.js";

const source = document.getElementById("source");
const linkCounter = document.getElementById("link-counter");
const resultCard = document.getElementById("result-card");
const resultOutput = document.getElementById("result-output");
const resultSummary = document.getElementById("result-summary");
const errorMessage = document.getElementById("error-message");
const copyButton = document.getElementById("copy-button");
const parseButton = document.getElementById("parse-button");
const clearButton = document.getElementById("clear-button");
const exampleButton = document.getElementById("example-button");

const example = ["https://t.me/c/1756869879/1218947", "https://t.me/c/1756869879/1218950"].join(
  "\n",
);

function getElement(element, name) {
  if (!element) {
    throw new Error(`Element #${name} is missing`);
  }
  return element;
}

const input = getElement(source, "source");
const counter = getElement(linkCounter, "link-counter");
const card = getElement(resultCard, "result-card");
const output = getElement(resultOutput, "result-output");
const summary = getElement(resultSummary, "result-summary");
const errors = getElement(errorMessage, "error-message");
const copy = getElement(copyButton, "copy-button");

function pluralize(count, one, few, many) {
  const lastTwo = count % 100;
  const last = count % 10;
  if (last === 1 && lastTwo !== 11) return one;
  if (last >= 2 && last <= 4 && (lastTwo < 12 || lastTwo > 14)) return few;
  return many;
}

function copyFallback(text) {
  const helper = document.createElement("textarea");
  helper.value = text;
  helper.setAttribute("readonly", "");
  helper.style.position = "fixed";
  helper.style.opacity = "0";
  document.body.append(helper);
  helper.select();
  const copied = document.execCommand("copy");
  helper.remove();
  if (!copied) {
    throw new Error("Copy failed");
  }
}

async function copyOutput() {
  const text = output.textContent ?? "";
  if (!text) return;

  try {
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(text);
    } else {
      copyFallback(text);
    }
    copy.textContent = "Скопировано ✓";
    window.setTimeout(() => {
      copy.textContent = "Скопировать";
    }, 1800);
  } catch {
    copy.textContent = "Не удалось скопировать";
    window.setTimeout(() => {
      copy.textContent = "Скопировать";
    }, 2200);
  }
}

function render() {
  const result = parseTelegramLinks(input.value);
  counter.textContent = `${result.linkCount} ${pluralize(result.linkCount, "ссылка", "ссылки", "ссылок")}`;

  if (!input.value.trim()) {
    card.hidden = true;
    copy.disabled = true;
    output.textContent = "";
    return;
  }

  const formatted = formatTelegramLinks(result);
  card.hidden = false;
  output.textContent = formatted || "Пока нечего копировать";
  copy.disabled = !formatted;

  if (formatted) {
    summary.textContent = `${result.groups.length} ${pluralize(result.groups.length, "чат", "чата", "чатов")} · ${result.uniqueMessageCount} ${pluralize(result.uniqueMessageCount, "уникальный ID", "уникальных ID", "уникальных ID")}`;
  } else {
    summary.textContent = "Вставь ссылки формата t.me/c/…/…";
  }

  if (result.invalidLines.length > 0) {
    const preview = result.invalidLines
      .slice(0, 3)
      .map(({ lineNumber, text }) => `строка ${lineNumber}: «${text}»`)
      .join(" · ");
    const suffix = result.invalidLines.length > 3 ? ` · ещё ${result.invalidLines.length - 3}` : "";
    errors.textContent = `Не распознано: ${preview}${suffix}`;
    errors.hidden = false;
  } else {
    errors.textContent = "";
    errors.hidden = true;
  }
}

input.addEventListener("input", render);
parseButton?.addEventListener("click", () => {
  render();
  input.focus();
});
clearButton?.addEventListener("click", () => {
  input.value = "";
  render();
  input.focus();
});
exampleButton?.addEventListener("click", () => {
  input.value = example;
  render();
  input.focus();
});
copy.addEventListener("click", copyOutput);

render();
