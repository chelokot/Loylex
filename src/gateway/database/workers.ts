import type { WorkerRegistration } from "../../shared/types.ts";
import { DatabaseArchive } from "./archive.ts";
import { type WorkerRow, type WorkerRuntimeRow, workerLeaseDurationMs } from "./types.ts";

export abstract class DatabaseWorkers extends DatabaseArchive {
  protected activeWorkerGeneration(): number {
    return (
      this.connection
        .query<WorkerRuntimeRow, []>(
          "SELECT active_worker_id, active_generation FROM worker_runtime WHERE id = 1",
        )
        .get()?.active_generation ?? 1
    );
  }

  protected worker(workerId: string): WorkerRow | null {
    return (
      this.connection
        .query<WorkerRow, [string]>(
          "SELECT worker_id, generation, state, registered_at, last_seen_at FROM workers WHERE worker_id = ?",
        )
        .get(workerId) ?? null
    );
  }

  protected hasRegisteredWorkers(): boolean {
    return Boolean(
      this.connection.query<{ value: number }, []>("SELECT 1 AS value FROM workers LIMIT 1").get(),
    );
  }

  protected moveWorkerGenerationInTransaction(
    sourceGeneration: number,
    targetGeneration: number,
    sourceWorkerId: string | null,
  ): void {
    if (sourceWorkerId === null) {
      this.connection
        .query(`
          UPDATE jobs
          SET state = 'pending',
              resume_thread_id = COALESCE(codex_thread_id, resume_thread_id),
              worker_id = NULL,
              lease_expires_at = NULL,
              claimed_at = NULL,
              worker_generation = ?
          WHERE state = 'running' AND worker_generation = ?
        `)
        .run(targetGeneration, sourceGeneration);
    } else {
      this.connection
        .query(`
          UPDATE jobs
          SET state = 'pending',
              resume_thread_id = COALESCE(codex_thread_id, resume_thread_id),
              worker_id = NULL,
              lease_expires_at = NULL,
              claimed_at = NULL,
              worker_generation = ?
          WHERE state = 'running' AND worker_id = ?
        `)
        .run(targetGeneration, sourceWorkerId);
    }
    this.connection
      .query(
        "UPDATE jobs SET worker_generation = ? WHERE state = 'pending' AND worker_generation = ?",
      )
      .run(targetGeneration, sourceGeneration);
  }

  registerWorker(workerId: string, now = Date.now()): WorkerRegistration {
    const transaction = this.connection.transaction(() => {
      const existing = this.worker(workerId);
      if (existing && existing.state !== "stopped") {
        this.connection
          .query("UPDATE workers SET last_seen_at = ? WHERE worker_id = ?")
          .run(now, workerId);
        return {
          generation: existing.generation,
          state: existing.state === "active" ? "active" : "draining",
        } satisfies WorkerRegistration;
      }

      const runtime = this.connection
        .query<WorkerRuntimeRow, []>(
          "SELECT active_worker_id, active_generation FROM worker_runtime WHERE id = 1",
        )
        .get() ?? { active_worker_id: null, active_generation: 1 };
      const active = runtime.active_worker_id ? this.worker(runtime.active_worker_id) : null;
      let generation = runtime.active_generation;

      if (active && active.state === "active") {
        generation += 1;
        if (active.last_seen_at >= now - workerLeaseDurationMs) {
          this.connection
            .query(
              "UPDATE workers SET state = 'draining', drain_requested_at = ? WHERE worker_id = ? AND state = 'active'",
            )
            .run(now, active.worker_id);
        } else {
          this.moveWorkerGenerationInTransaction(active.generation, generation, active.worker_id);
          this.connection
            .query("UPDATE workers SET state = 'stopped', last_seen_at = ? WHERE worker_id = ?")
            .run(now, active.worker_id);
        }
      } else if (runtime.active_worker_id !== null) {
        generation += 1;
        this.moveWorkerGenerationInTransaction(
          runtime.active_generation,
          generation,
          active?.worker_id ?? null,
        );
        if (active) {
          this.connection
            .query("UPDATE workers SET state = 'stopped', last_seen_at = ? WHERE worker_id = ?")
            .run(now, active.worker_id);
        }
      }

      const reclaimable = this.connection
        .query<WorkerRow, [number]>(`
          SELECT worker_id, generation, state, registered_at, last_seen_at
          FROM workers
          WHERE state = 'stopped'
             OR (state = 'draining' AND last_seen_at < ?)
        `)
        .all(now - workerLeaseDurationMs);
      for (const worker of reclaimable) {
        if (worker.worker_id === workerId || worker.generation === generation) {
          continue;
        }
        this.moveWorkerGenerationInTransaction(worker.generation, generation, worker.worker_id);
        this.connection
          .query("UPDATE workers SET state = 'stopped', last_seen_at = ? WHERE worker_id = ?")
          .run(now, worker.worker_id);
      }

      this.connection
        .query(`
          INSERT INTO workers (worker_id, generation, state, registered_at, last_seen_at, drain_requested_at)
          VALUES (?, ?, 'active', ?, ?, NULL)
          ON CONFLICT(worker_id) DO UPDATE SET
            generation = excluded.generation,
            state = 'active',
            registered_at = excluded.registered_at,
            last_seen_at = excluded.last_seen_at,
            drain_requested_at = NULL
        `)
        .run(workerId, generation, now, now);
      this.connection
        .query(
          "UPDATE worker_runtime SET active_worker_id = ?, active_generation = ?, updated_at = ? WHERE id = 1",
        )
        .run(workerId, generation, now);
      return { generation, state: "active" } satisfies WorkerRegistration;
    });
    return transaction.immediate();
  }

  heartbeatWorker(workerId: string, now = Date.now()): boolean {
    const result = this.connection
      .query(
        "UPDATE workers SET last_seen_at = ? WHERE worker_id = ? AND state IN ('active', 'draining')",
      )
      .run(now, workerId);
    return result.changes > 0;
  }

  stopWorker(workerId: string, now = Date.now()): boolean {
    const transaction = this.connection.transaction(() => {
      const worker = this.worker(workerId);
      if (!worker) {
        return false;
      }
      const activeGeneration = this.activeWorkerGeneration();
      if (worker.generation !== activeGeneration) {
        this.moveWorkerGenerationInTransaction(worker.generation, activeGeneration, workerId);
      }
      const result = this.connection
        .query("UPDATE workers SET state = 'stopped', last_seen_at = ? WHERE worker_id = ?")
        .run(now, workerId);
      return result.changes > 0;
    });
    return transaction.immediate();
  }

  shouldDrainWorker(workerId: string): boolean {
    const worker = this.worker(workerId);
    if (!worker || worker.state !== "draining") {
      return false;
    }
    const work =
      this.connection
        .query<{ count: number }, [number]>(
          "SELECT count(*) AS count FROM jobs WHERE worker_generation = ? AND state IN ('pending', 'running')",
        )
        .get(worker.generation)?.count ?? 0;
    return work === 0;
  }

  recoverExpiredJobs(now = Date.now()): number {
    const transaction = this.connection.transaction(() =>
      this.recoverExpiredJobsInTransaction(now),
    );
    return transaction.immediate();
  }

  protected recoverExpiredJobsInTransaction(now: number): number {
    return this.recoverJobsInTransaction(now, true);
  }

  protected recoverExpiredLeasesInTransaction(now: number): number {
    return this.recoverJobsInTransaction(now, false);
  }

  protected recoverJobsInTransaction(now: number, includeUnleased: boolean): number {
    const condition = includeUnleased
      ? "(worker_id IS NULL OR lease_expires_at IS NULL OR lease_expires_at < ?)"
      : "lease_expires_at IS NOT NULL AND lease_expires_at < ?";
    const jobs = this.connection
      .query<{ id: number; worker_id: string | null; worker_generation: number }, [number]>(`
        SELECT id, worker_id, worker_generation
        FROM jobs
        WHERE state = 'running'
          AND ${condition}
        ORDER BY id
      `)
      .all(now);
    let recovered = 0;
    for (const job of jobs) {
      // A job lease can expire while its worker is still alive (for example when a
      // long-running tool call delays the per-job heartbeat). Do not hand that job to a
      // second Codex process: the original process may still hold the thread writer lock.
      if (job.worker_id !== null && this.hasLiveWorkerLease(job.worker_id, now)) {
        continue;
      }
      const generation = this.generationForRecovery(job.worker_id, job.worker_generation, now);
      this.connection
        .query(`
          UPDATE jobs
          SET state = 'pending',
              resume_thread_id = COALESCE(codex_thread_id, resume_thread_id),
              worker_id = NULL,
              lease_expires_at = NULL,
              claimed_at = NULL,
              worker_generation = ?
          WHERE id = ? AND state = 'running'
        `)
        .run(generation, job.id);
      recovered += 1;
    }
    return recovered;
  }

  protected hasLiveWorkerLease(workerId: string, now: number): boolean {
    const owner = this.worker(workerId);
    return (
      owner !== null &&
      owner.state !== "stopped" &&
      owner.last_seen_at >= now - workerLeaseDurationMs
    );
  }

  protected generationForRecovery(
    workerId: string | null,
    generation: number,
    now: number,
  ): number {
    if (workerId !== null) {
      const owner = this.worker(workerId);
      if (owner?.state === "active" && owner.last_seen_at >= now - workerLeaseDurationMs) {
        return generation;
      }
    }
    return this.activeWorkerGeneration();
  }
}
