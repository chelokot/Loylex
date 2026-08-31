type ApiPayload = Record<string, unknown>;

type ApiOptions = {
  apiRoot?: string;
  environment?: "prod" | "test";
  timeoutSeconds?: number;
  fetch?: typeof fetch;
  baseFetchConfig?: Record<string, unknown>;
  sensitiveLogs?: boolean;
};

export declare class Api {
  constructor(token: string, options?: ApiOptions);

  getMe(signal?: AbortSignal): Promise<unknown>;
  getUpdates(other?: ApiPayload, signal?: AbortSignal): Promise<unknown>;
  deleteWebhook(other?: ApiPayload, signal?: AbortSignal): Promise<unknown>;
  sendRichMessage(
    chatId: number | string,
    richMessage: ApiPayload,
    other?: ApiPayload,
    signal?: AbortSignal,
  ): Promise<unknown>;
  sendDocument(
    chatId: number | string,
    document: InputFile,
    other?: ApiPayload,
    signal?: AbortSignal,
  ): Promise<unknown>;
  sendMediaGroup(
    chatId: number | string,
    media: unknown[],
    other?: ApiPayload,
    signal?: AbortSignal,
  ): Promise<unknown>;
  setMessageReaction(
    chatId: number | string,
    messageId: number,
    reaction: unknown[],
    other?: ApiPayload,
    signal?: AbortSignal,
  ): Promise<unknown>;
  sendRichMessageDraft(
    chatId: number | string,
    draftId: number,
    richMessage: ApiPayload,
    other?: ApiPayload,
    signal?: AbortSignal,
  ): Promise<unknown>;
  sendChatAction(
    chatId: number | string,
    action: string,
    other?: ApiPayload,
    signal?: AbortSignal,
  ): Promise<unknown>;
  getFile(fileId: string, signal?: AbortSignal): Promise<unknown>;
  setMyCommands(commands: unknown[], other?: ApiPayload, signal?: AbortSignal): Promise<unknown>;
  editMessageText(
    chatId: number | string,
    messageId: number,
    textOrRichMessage: string | ApiPayload,
    other?: ApiPayload,
    signal?: AbortSignal,
  ): Promise<unknown>;
  deleteMessage(chatId: number | string, messageId: number, signal?: AbortSignal): Promise<unknown>;
}

export declare class InputFile {
  constructor(file: Blob | Uint8Array | string | URL | { url: string }, filename?: string);
}
