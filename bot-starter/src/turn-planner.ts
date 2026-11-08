import { Worker } from "node:worker_threads";
import type { TurnPlan, TurnRequest } from "./turn-worker.js";

export class TurnPlanner {
  private readonly worker: Worker;
  private pending?: {
    resolve: (plan: TurnPlan) => void;
    reject: (error: Error) => void;
  };
  private failure?: Error;

  constructor() {
    const source = import.meta.url.endsWith(".ts");
    const entry = new URL(
      source ? "./turn-worker.ts" : "./turn-worker.js",
      import.meta.url,
    );
    // The bootstrap registers tsx inside the worker when running from source.
    this.worker = source
      ? new Worker(
          `
          import(${JSON.stringify(import.meta.resolve("tsx/esm/api"))}).then(({ register }) => {
            register();
            return import(${JSON.stringify(entry.href)});
          }).catch((error) => { throw error; });
        `,
          { eval: true },
        )
      : new Worker(entry);
    this.worker.on("message", (plan: TurnPlan) => {
      const pending = this.pending;
      this.pending = undefined;
      pending?.resolve(plan);
    });
    this.worker.on("error", (error) => this.fail(error));
    this.worker.on("exit", (code) =>
      this.fail(new Error(`Turn search exited (${code})`)),
    );
  }

  get busy() {
    return this.pending !== undefined;
  }

  plan(request: TurnRequest): Promise<TurnPlan> {
    if (this.failure) return Promise.reject(this.failure);
    if (this.pending) return Promise.reject(new Error("Turn search is busy"));
    return new Promise((resolve, reject) => {
      this.worker.postMessage(request);
      this.pending = { resolve, reject };
    });
  }

  close() {
    return this.worker.terminate();
  }

  private fail(error: Error) {
    this.failure = error;
    const pending = this.pending;
    this.pending = undefined;
    pending?.reject(error);
  }
}
