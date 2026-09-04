import type { TelegramMessage } from "../shared/types.ts";
import type { JobSummary, LoylexDatabase } from "./database.ts";
import { responseOptions } from "./message-options.ts";
import type { TelegramClient } from "./telegram.ts";

const recentTasksLimit = 5;
const taskLabelLength = 40;

const stateLabels = {
  pending: "Ожидает",
  running: "Выполняется",
  completed: "Завершено",
  failed: "Ошибка",
  cancelled: "Остановлено",
} satisfies Record<JobSummary["state"], string>;

function escapeHtml(value: string): string {
  return value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
}

function escapeHtmlAttribute(value: string): string {
  return escapeHtml(value).replaceAll('"', "&quot;");
}

function taskLabel(prompt: string): string {
  const normalized = prompt.replaceAll(/\s+/g, " ").trim();
  const label = Array.from(normalized).slice(0, taskLabelLength).join("");
  return label || "Без текста";
}

function datePart(value: number): string {
  return String(value).padStart(2, "0");
}

function formatDate(timestamp: number | null): string {
  if (timestamp === null || !Number.isFinite(timestamp)) {
    return "неизвестно";
  }
  const date = new Date(timestamp);
  if (Number.isNaN(date.getTime())) {
    return "неизвестно";
  }
  return `${date.getFullYear()}-${datePart(date.getMonth() + 1)}-${datePart(date.getDate())} ${datePart(date.getHours())}:${datePart(date.getMinutes())}`;
}

function messageLink(task: JobSummary): string {
  const messageId = task.thinkingMessageId ?? task.messageId;
  const chatId = String(task.chatId);
  if (chatId.startsWith("-100")) {
    return `https://t.me/c/${chatId.slice(4)}/${messageId}`;
  }
  return `tg://openmessage?chat_id=${encodeURIComponent(chatId)}&message_id=${messageId}`;
}

function statusLabel(state: JobSummary["state"]): string {
  return stateLabels[state];
}

function cancelCommand(task: JobSummary): string {
  return `/cancel_${task.messageId}`;
}

function resumeCommand(task: JobSummary): string {
  return `/resume_${task.messageId}`;
}

function formatTask(task: JobSummary): string {
  const label = escapeHtml(taskLabel(task.prompt));
  const link = escapeHtmlAttribute(messageLink(task));
  const dates = [formatDate(task.createdAt)];
  if (task.completedAt !== null) {
    dates.push(formatDate(task.completedAt));
  }
  const controls: string[] = [];
  if (task.state === "pending" || task.state === "running") {
    controls.push(cancelCommand(task));
  } else if (task.canResume) {
    controls.push(resumeCommand(task));
  }
  return [
    `${statusLabel(task.state)} <a href="${link}">${label}</a>`,
    dates.join(" - "),
    ...controls,
  ].join("  \n");
}

export function formatTasksDocument(tasks: JobSummary[]): string {
  if (tasks.length === 0) {
    return "Задач пока нет.";
  }
  return tasks.map(formatTask).join("\n\n");
}

export async function sendTasks(
  database: LoylexDatabase,
  telegram: TelegramClient,
  message: TelegramMessage,
): Promise<void> {
  const tasks = database.listRecentJobs(message.chat.id, recentTasksLimit);
  await telegram.sendRich(message.chat.id, formatTasksDocument(tasks), {
    ...responseOptions(message.chat.type, message.message_id, message.message_thread_id ?? null),
    disableLinkPreview: true,
  });
}
