import { createHash } from "node:crypto";
import type { Notification, Pool, PoolClient } from "pg";

export const RUN_EVENT_WAKE_CHANNEL = "hoox_run_event_wake";

/** 通知只携带不可逆的路由键；正文和授权仍由 Tenant 事务读取。 */
export function runEventWakeKey(tenantId: string, runId: string): string {
  return createHash("sha256").update(`${tenantId}\0${runId}`).digest("hex");
}

/** 一个 API 进程共用一条独占监听连接；断线不会改变游标或持久事实。 */
export class PgRunEventWakeListener {
  private readonly listeners = new Map<string, Set<() => void>>();
  private active: PoolClient | undefined;
  private connecting: Promise<void> | undefined;
  private retry: ReturnType<typeof setTimeout> | undefined;
  private closed = false;

  constructor(private readonly pool: Pool) {}

  subscribe(tenantId: string, runId: string, wake: () => void): () => void {
    if (this.closed) return () => {};
    const key = runEventWakeKey(tenantId, runId);
    const group = this.listeners.get(key) ?? new Set<() => void>();
    group.add(wake);
    this.listeners.set(key, group);
    this.connect();
    return () => {
      group.delete(wake);
      if (group.size === 0) this.listeners.delete(key);
    };
  }

  async close(): Promise<void> {
    this.closed = true;
    if (this.retry !== undefined) clearTimeout(this.retry);
    this.listeners.clear();
    await this.connecting;
    const client = this.active;
    this.active = undefined;
    if (client !== undefined) {
      client.removeListener("notification", this.onNotification);
      client.removeListener("error", this.onError);
      client.release(true);
    }
    await this.pool.end();
  }

  private readonly onNotification = (notification: Notification): void => {
    if (notification.channel !== RUN_EVENT_WAKE_CHANNEL) return;
    for (const wake of this.listeners.get(notification.payload ?? "") ?? []) wake();
  };

  private readonly onError = (): void => {
    const client = this.active;
    if (client !== undefined) {
      this.active = undefined;
      client.removeListener("notification", this.onNotification);
      client.removeListener("error", this.onError);
      client.release(true);
    }
    this.scheduleRetry();
  };

  private connect(): void {
    if (this.closed || this.active !== undefined || this.connecting !== undefined) return;
    this.connecting = this.open().finally(() => {
      this.connecting = undefined;
    });
  }

  private async open(): Promise<void> {
    let client: PoolClient | undefined;
    try {
      client = await this.pool.connect();
      if (this.closed) {
        client.release(true);
        return;
      }
      this.active = client;
      client.on("notification", this.onNotification);
      client.on("error", this.onError);
      await client.query(`LISTEN ${RUN_EVENT_WAKE_CHANNEL}`);
      if (this.active !== client) return;
      if (this.closed) {
        this.onError();
        return;
      }
      // 订阅建立前可能已经提交了事件；建立监听后主动补读一次。
      for (const group of this.listeners.values()) for (const wake of group) wake();
    } catch {
      if (client !== undefined && this.active === client) this.onError();
      this.scheduleRetry();
    }
  }

  private scheduleRetry(): void {
    if (this.closed || this.retry !== undefined) return;
    this.retry = setTimeout(() => {
      this.retry = undefined;
      this.connect();
    }, 1_000);
    this.retry.unref();
  }
}
