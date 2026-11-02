import type { TelegramMessage } from "../shared/types.ts";
import type { LoylexDatabase } from "./database.ts";
import type { LeylobucksMode } from "./leylobucks-mode.ts";
import {
  leylobucksInvalidCommandMessage,
  leylobucksModeMessage,
  leylobucksPurchaseMessage,
  leylobucksQuizMessage,
  leylobucksStatusMessage,
  leylobucksTestBumpInvalidMessage,
  leylobucksTestBumpMessage,
} from "./presentation.ts";
import {
  isSlashCommand,
  parseLeylobucksCommand,
  parseQuizCommand,
  parseTestBumpCommand,
} from "./triggers.ts";

export class LeylobucksCommands {
  constructor(
    private readonly database: LoylexDatabase,
    private readonly mode: LeylobucksMode,
    private readonly botUsername: string | undefined,
    private readonly send: (message: TelegramMessage, markdown: string) => Promise<void>,
  ) {}

  quizAnswer(userId: number, answer: string): string | null {
    this.mode.interact(userId);
    return this.mode.isEnabled(userId)
      ? leylobucksQuizMessage(this.database.quizLeylobucks(userId, answer))
      : null;
  }

  async handle(message: TelegramMessage, currentUserId: number | null): Promise<boolean> {
    const leylobucksCommand = parseLeylobucksCommand(message, this.botUsername);
    const quizCommand = parseQuizCommand(message, this.botUsername);
    if (currentUserId !== null && (leylobucksCommand || quizCommand)) {
      this.mode.interact(currentUserId);
    }
    const testBumpCommand = parseTestBumpCommand(message, this.botUsername);
    if (testBumpCommand && currentUserId !== null) {
      this.mode.interact(currentUserId);
      await this.send(
        message,
        testBumpCommand.amount === null
          ? leylobucksTestBumpInvalidMessage()
          : leylobucksTestBumpMessage(
              this.database.testBumpLeylobucks(currentUserId, testBumpCommand.amount),
            ),
      );
      return true;
    }
    const economyEnabled = this.mode.isEnabled(currentUserId);
    if (leylobucksCommand && currentUserId !== null) {
      if (leylobucksCommand.kind === "toggle") {
        this.mode.setEnabled(currentUserId, leylobucksCommand.enabled);
        await this.send(message, leylobucksModeMessage(leylobucksCommand.enabled));
        return true;
      }
      if (economyEnabled) {
        const markdown =
          leylobucksCommand.kind === "status"
            ? leylobucksStatusMessage(this.database.leylobucksStatus(currentUserId))
            : leylobucksCommand.kind === "buy"
              ? leylobucksPurchaseMessage(
                  this.database.purchaseLeylobucks(currentUserId, leylobucksCommand.cost),
                )
              : leylobucksInvalidCommandMessage();
        await this.send(message, markdown);
        return true;
      }
      if (isSlashCommand(message)) {
        return true;
      }
    }
    if (economyEnabled && quizCommand && currentUserId !== null) {
      await this.send(
        message,
        leylobucksQuizMessage(this.database.quizLeylobucks(currentUserId, quizCommand.answer)),
      );
      return true;
    }
    return false;
  }
}
