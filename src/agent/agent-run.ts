import type { AgentEvent } from "../shared/types.ts";
import type { AgentTokenUsage } from "../shared/usage.ts";

export type AgentProvider = "codex" | "claude";

export type SteerControl = {
  threadId: string;
  send(text: string, clientId: string): Promise<void>;
};

export type AgentRun = {
  instructions: string;
  prompt: string;
  resumeThreadId: string | null;
  signal: AbortSignal;
  onEvent(event: AgentEvent): Promise<void>;
  onUsage(usage: AgentTokenUsage, threadId: string): Promise<void>;
  onReady(control: SteerControl | null): void;
};

export type AgentRunResult = {
  answer: string;
  threadId: string;
  usage?: AgentTokenUsage;
};

export class AgentCancelledError extends Error {
  constructor() {
    super("Agent run cancelled");
    this.name = "AgentCancelledError";
  }
}

export class AgentLimitError extends Error {
  readonly provider: AgentProvider;
  readonly resetsAtMs: number | null;

  constructor(provider: AgentProvider, message: string, resetsAtMs: number | null = null) {
    super(message);
    this.name = "AgentLimitError";
    this.provider = provider;
    this.resetsAtMs = resetsAtMs;
  }
}
