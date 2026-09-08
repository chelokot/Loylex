/**
 * Runtime-only feature flag for the chat-local Loylebucks mode.
 *
 * This deliberately does not use the database: switching the mode must not
 * mutate balances, transactions, quiz state, or historical jobs. A gateway
 * restart restores the default enabled state.
 */
export class LeylobucksMode {
  readonly #enabledByChat = new Map<number, boolean>();

  isEnabled(chatId: number): boolean {
    return this.#enabledByChat.get(chatId) ?? true;
  }

  setEnabled(chatId: number, enabled: boolean): void {
    this.#enabledByChat.set(chatId, enabled);
  }
}
