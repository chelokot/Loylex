/**
 * Runtime-only feature flag for the user-local Loylebucks mode.
 *
 * This deliberately does not use the database: switching the mode must not
 * mutate balances, transactions, quiz state, or historical jobs. A gateway
 * restart restores the default enabled state.
 */
export class LeylobucksMode {
  readonly #enabledByUser = new Map<number, boolean>();

  isEnabled(userId: number | null): boolean {
    return userId === null ? true : (this.#enabledByUser.get(userId) ?? true);
  }

  setEnabled(userId: number, enabled: boolean): void {
    this.#enabledByUser.set(userId, enabled);
  }
}
