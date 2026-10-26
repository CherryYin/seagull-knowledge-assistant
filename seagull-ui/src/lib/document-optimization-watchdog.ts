const MINUTE_MS = 60_000;
const IDLE_LIMIT_MS = 5 * MINUTE_MS;

export class DocumentOptimizationWatchdog {
  readonly activeLimitMs: number;
  private previousTime: number;
  private elapsedMs = 0;
  private idleMs = 0;
  private waiting = false;

  constructor(inputCharacters: number, startedAt: number) {
    this.activeLimitMs = Math.min(20, Math.max(10, 5 + Math.ceil(inputCharacters / 4000))) * MINUTE_MS;
    this.previousTime = startedAt;
  }

  private advance(now: number) {
    const delta = Math.max(0, now - this.previousTime);
    this.previousTime = now;
    if (!this.waiting) {
      this.elapsedMs += delta;
      this.idleMs += delta;
    }
  }

  activity(now: number) {
    this.advance(now);
    this.idleMs = 0;
  }

  waitForAnswer(waiting: boolean, now: number) {
    this.advance(now);
    this.waiting = waiting;
    this.idleMs = 0;
  }

  status(now: number) {
    this.advance(now);
    return {
      elapsedSeconds: Math.floor(this.elapsedMs / 1000),
      idleSeconds: Math.floor(this.idleMs / 1000),
      limitMinutes: this.activeLimitMs / MINUTE_MS,
      timeout: this.waiting ? null : this.elapsedMs >= this.activeLimitMs ? "deadline" : this.idleMs >= IDLE_LIMIT_MS ? "idle" : null,
    };
  }
}
