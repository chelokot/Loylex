export type LeylobucksModeStore = {
  isEnabled(userId: number): boolean;
  setEnabled(userId: number, enabled: boolean): void;
};

export class LeylobucksMode {
  constructor(
    private readonly store: LeylobucksModeStore,
    private readonly activity?: {
      isVisible(userId: number): boolean;
      interact(userId: number): void;
    },
  ) {}

  isEnabled(userId: number | null): boolean {
    return userId === null
      ? true
      : this.store.isEnabled(userId) && (this.activity?.isVisible(userId) ?? true);
  }

  interact(userId: number): void {
    if (this.store.isEnabled(userId)) this.activity?.interact(userId);
  }

  setEnabled(userId: number, enabled: boolean): void {
    this.store.setEnabled(userId, enabled);
    this.activity?.interact(userId);
  }
}
