import { readFileSync } from "node:fs";
import type { JsonObject, TelegramCallbackQuery } from "../shared/types.ts";

export class ApprovalDeniedError extends Error {}

export class ApprovalClient {
  constructor(
    private readonly token: string,
    private readonly baseUrl: string,
    private readonly certificate: string,
  ) {}

  static fromEnvironment(): ApprovalClient {
    const path = process.env.LOYLEX_GATEWAY_SUPERVISOR_TOKEN_FILE;
    if (!path) throw new Error("LOYLEX_GATEWAY_SUPERVISOR_TOKEN_FILE is required");
    const certificatePath = process.env.LOYLEX_GATEWAY_SUPERVISOR_CA_FILE;
    if (!certificatePath) throw new Error("LOYLEX_GATEWAY_SUPERVISOR_CA_FILE is required");
    return new ApprovalClient(
      readFileSync(path, "utf8").trim(),
      "https://host.containers.internal:8791",
      readFileSync(certificatePath, "utf8"),
    );
  }

  private async request(path: string, payload?: unknown): Promise<unknown> {
    const response = await fetch(`${this.baseUrl}/v1/approvals/${path}`, {
      method: payload === undefined ? "GET" : "POST",
      headers: { authorization: `Bearer ${this.token}`, "content-type": "application/json" },
      ...(payload === undefined ? {} : { body: JSON.stringify(payload) }),
      signal: AbortSignal.timeout(120_000),
      tls: { ca: this.certificate },
    });
    if (!response.ok)
      throw new Error(`Approval broker ${response.status}: ${await response.text()}`);
    return response.json();
  }

  submit(
    address: { chatId: number; messageId: number; threadId: number | null },
    operation: unknown,
  ): Promise<unknown> {
    return this.request("submit", {
      chatId: address.chatId,
      replyId: address.messageId,
      threadId: address.threadId,
      operation,
    });
  }

  status(identifier: string): Promise<unknown> {
    return this.request(identifier);
  }

  async callback(callback: TelegramCallbackQuery): Promise<{ accepted: boolean; state?: string }> {
    return (await this.request("callback", callback)) as { accepted: boolean; state?: string };
  }

  async guard(method: string, parameters: JsonObject): Promise<void> {
    const normalized = method.toLowerCase();
    if (
      !normalized.startsWith("editmessage") &&
      !normalized.startsWith("deletemessage") &&
      ![
        "getupdates",
        "setwebhook",
        "deletewebhook",
        "logout",
        "close",
        "deleteforumtopic",
        "deletebusinessmessages",
      ].includes(normalized)
    )
      return;
    const result = (await this.request("telegram-guard", {
      method: normalized,
      params: parameters,
    })) as { allowed: boolean };
    if (!result.allowed)
      throw new ApprovalDeniedError("This Telegram operation is protected by the approval broker");
  }
}
