import { afterEach, describe, expect, test } from "bun:test";

import { message, removeDatabases, setup } from "./fixtures/database.ts";

afterEach(removeDatabases);

describe("LoylexDatabase", () => {
  test("keeps old-generation work with the draining worker", () => {
    const database = setup();
    expect(database.registerWorker("blue", 1_000)).toEqual({ generation: 1, state: "active" });

    const old = message(1, "старая задача");
    const oldFollowUp = message(2, "старое продолжение");
    database.enqueue(55, old, "старая", null);

    const oldJob = database.claimNext(10, "blue");
    expect(oldJob?.messageId).toBe(1);
    database.appendStatus(oldJob?.id ?? 0, "commentary: работаю", "thread-old", "blue");
    database.enqueue(56, oldFollowUp, "продолжай старое", "thread-old");

    expect(database.registerWorker("green", 2_000)).toEqual({ generation: 2, state: "active" });
    const newMessage = message(3, "новая задача");
    database.enqueue(57, newMessage, "новая", null);

    expect(database.claimNext(10, "blue")).toBeNull();
    expect(database.shouldDrainWorker("blue")).toBe(false);

    expect(database.complete(oldJob?.id ?? 0, 101, "thread-old", "blue")).toBe(true);
    const oldContinuation = database.claimNext(10, "blue");
    expect(oldContinuation?.messageId).toBe(2);
    expect(database.complete(oldContinuation?.id ?? 0, 102, "thread-old", "blue")).toBe(true);
    expect(database.shouldDrainWorker("blue")).toBe(true);

    const newJob = database.claimNext(10, "green");
    expect(newJob?.messageId).toBe(3);
    expect(database.complete(newJob?.id ?? 0, 103, "thread-new", "green")).toBe(true);
    database.close();
  });

  test("does not requeue an expired lease while its worker is alive", () => {
    const database = setup();
    const now = Date.now();
    database.registerWorker("worker-a", now);

    const incoming = message(1, "долгая задача");
    database.enqueue(55, incoming, "долгая задача", null);
    const running = database.claimNext(10, "worker-a");
    expect(running).not.toBeNull();
    database.appendStatus(running?.id ?? 0, "commentary: работаю", "thread-123", "worker-a");

    database.connection
      .query("UPDATE jobs SET lease_expires_at = ? WHERE id = ?")
      .run(now - 1, running?.id ?? 0);
    database.heartbeatWorker("worker-a", now);

    expect(database.recoverExpiredJobs(now)).toBe(0);
    expect(database.claimNext(10, "worker-a")).toBeNull();
    database.close();
  });

  test("requeues an expired lease after its worker stops being live", () => {
    const database = setup();
    const now = Date.now();
    database.registerWorker("worker-a", now);

    const incoming = message(1, "задача после сбоя worker");
    database.enqueue(55, incoming, "задача после сбоя worker", null);
    const running = database.claimNext(10, "worker-a");
    expect(running).not.toBeNull();
    database.connection
      .query("UPDATE jobs SET lease_expires_at = ? WHERE id = ?")
      .run(now - 1, running?.id ?? 0);
    database.heartbeatWorker("worker-a", now - 60_000);

    expect(database.recoverExpiredJobs(now)).toBe(1);
    database.registerWorker("worker-b", now);
    const recovered = database.claimNext(10, "worker-b");
    expect(recovered?.id).toBe(running?.id);
    expect(recovered?.resumeThreadId).toBeNull();
    database.close();
  });

  test("reassigns queued old-generation work when a worker stops", () => {
    const database = setup();
    database.registerWorker("blue", 1_000);
    const old = message(1, "старая очередь");
    database.enqueue(55, old, "старая", null);
    database.registerWorker("green", 2_000);

    expect(database.stopWorker("blue", 3_000)).toBe(true);
    const reassigned = database.claimNext(10, "green");
    expect(reassigned?.messageId).toBe(1);
    expect(database.complete(reassigned?.id ?? 0, 101, "thread-new", "green")).toBe(true);
    database.close();
  });

  test("recovers pending work after the draining worker disappears without another rollout", () => {
    const database = setup();
    const now = Date.now();
    database.registerWorker("blue", now);
    database.enqueue(55, message(1, "очередь до rollout"), "продолжай", null);
    database.registerWorker("green", now);

    expect(database.claimNext(10, "green")).toBeNull();
    database.heartbeatWorker("blue", now - 60_000);

    const recovered = database.claimNext(10, "green");
    expect(recovered?.messageId).toBe(1);
    expect(database.claimNext(10, "blue")).toBeNull();
    expect(database.complete(recovered?.id ?? 0, 101, "thread-new", "green")).toBe(true);
    expect(database.claimNext(10, "green")).toBeNull();
    database.close();
  });

  test("does not reclaim live draining work or replay completed replies", () => {
    const database = setup();
    const now = Date.now();
    database.registerWorker("blue", now);
    database.enqueue(55, message(1, "готовая"), "готовая", null);
    const finished = database.claimNext(10, "blue");
    database.complete(finished?.id ?? 0, 101, "thread-done", "blue");
    database.enqueue(56, message(2, "долгая"), "долгая", null);
    const running = database.claimNext(10, "blue");
    database.enqueue(57, message(3, "ожидающая"), "ожидающая", null);
    database.registerWorker("green", now);
    database.connection
      .query("UPDATE jobs SET lease_expires_at = ? WHERE id = ?")
      .run(now - 1, running?.id ?? 0);

    expect(database.claimNext(10, "green")).toBeNull();
    expect(database.complete(running?.id ?? 0, 102, "thread-long", "blue")).toBe(true);
    database.heartbeatWorker("blue", now - 60_000);
    const recovered = database.claimNext(10, "green");
    expect(recovered?.messageId).toBe(3);
    database.complete(recovered?.id ?? 0, 103, "thread-next", "green");
    expect(database.claimNext(10, "green")).toBeNull();
    database.close();
  });
});
