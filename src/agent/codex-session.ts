import { open, stat } from "node:fs/promises";
import { join } from "node:path";

// Codex's exec JSON stream omits Extension items that are present in its rollout.
// Read only new, bounded journal records; never interpret tool input as code.
export class CodexSessionExtensions {
  private path: string | null = null;
  private offset = 0;
  private pending = "";
  private discarding = false;
  private readonly decoder = new TextDecoder();

  constructor(
    private readonly home: string,
    private readonly startedAt = Date.now(),
  ) {}

  async skipExisting(threadId: string): Promise<void> {
    await this.find(threadId);
    if (this.path) this.offset = (await stat(this.path)).size;
  }

  private async find(threadId: string): Promise<void> {
    if (!/^[a-zA-Z0-9-]+$/.test(threadId)) return;
    if (!this.path) {
      const glob = new Bun.Glob(`**/rollout-*-${threadId}.jsonl`);
      for await (const path of glob.scan(join(this.home, "sessions"))) {
        this.path = join(this.home, "sessions", path);
        break;
      }
    }
  }

  async read(threadId: string): Promise<unknown[]> {
    await this.find(threadId);
    if (!this.path) return [];
    const size = (await stat(this.path)).size;
    const file = await open(this.path, "r");
    const items: unknown[] = [];
    try {
      // Limit work per stdout chunk, even when resuming a large historical journal.
      const buffer = Buffer.alloc(Math.min(Math.max(size - this.offset, 0), 1024 * 1024));
      const { bytesRead } = await file.read(buffer, 0, buffer.length, this.offset);
      this.offset += bytesRead;
      const lines = (
        this.pending + this.decoder.decode(buffer.subarray(0, bytesRead), { stream: true })
      ).split("\n");
      this.pending = lines.pop() ?? "";
      for (const line of lines) {
        if (this.discarding) {
          this.discarding = false;
          continue;
        }
        try {
          const record = JSON.parse(line);
          if (
            Date.parse(record.timestamp) >= this.startedAt &&
            record.type === "event_msg" &&
            record.payload?.thread_id === threadId &&
            record.payload?.type === "item_completed" &&
            record.payload?.item?.type === "Extension"
          )
            items.push(record.payload.item);
        } catch {
          // A malformed record must not abort the user's task.
        }
      }
      if (this.pending.length > 1024 * 1024) {
        this.pending = "";
        this.discarding = true;
      }
    } finally {
      await file.close();
    }
    return items;
  }
}
