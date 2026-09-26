export type LeylobucksModeStore = {
  isEnabled(userId: number): boolean;
  setEnabled(userId: number, enabled: boolean): void;
};

export class LeylobucksMode {
  constructor(private readonly store: LeylobucksModeStore) {}

  isEnabled(userId: number | null): boolean {
    return userId === null ? true : this.store.isEnabled(userId);
  }

  setEnabled(userId: number, enabled: boolean): void {
    this.store.setEnabled(userId, enabled);
  }
}
