import { EventEmitter } from "node:events";
import type { Pool } from "pg";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  PgRunEventWakeListener,
  RUN_EVENT_WAKE_CHANNEL,
  runEventWakeKey,
} from "./pg-run-event-wake.js";

function fixture() {
  const client = Object.assign(new EventEmitter(), {
    query: vi.fn(async () => ({})),
    release: vi.fn(),
  });
  const pool = { connect: vi.fn(async () => client), end: vi.fn(async () => {}) };
  return { client, pool, listener: new PgRunEventWakeListener(pool as unknown as Pool) };
}
afterEach(() => vi.useRealTimers());
describe("Run 事件数据库唤醒", () => {
  it("多个订阅共用连接，通知按租户和 Run 精确路由，退订后不再唤醒", async () => {
    const { client, pool, listener } = fixture();
    const a = vi.fn();
    const b = vi.fn();
    const off = listener.subscribe("tenant_a", "run", a);
    listener.subscribe("tenant_b", "run", b);
    await vi.waitFor(() => expect(a).toHaveBeenCalledOnce());
    expect(pool.connect).toHaveBeenCalledOnce();
    a.mockClear();
    b.mockClear();
    client.emit("notification", {
      channel: RUN_EVENT_WAKE_CHANNEL,
      payload: runEventWakeKey("tenant_a", "run"),
    });
    expect(a).toHaveBeenCalledOnce();
    expect(b).not.toHaveBeenCalled();
    off();
    client.emit("notification", {
      channel: RUN_EVENT_WAKE_CHANNEL,
      payload: runEventWakeKey("tenant_a", "run"),
    });
    expect(a).toHaveBeenCalledOnce();
    await listener.close();
    expect(client.release).toHaveBeenCalledExactlyOnceWith(true);
    expect(client.listenerCount("notification")).toBe(0);
    expect(pool.end).toHaveBeenCalledOnce();
  });

  it("LISTEN 过程中断线不重复释放连接，重新订阅后主动补读", async () => {
    vi.useFakeTimers();
    const { client, pool, listener } = fixture();
    client.query.mockImplementationOnce(async () => {
      client.emit("error", new Error("disconnected"));
      throw new Error("disconnected");
    });
    const wake = vi.fn();
    listener.subscribe("tenant", "run", wake);
    await vi.advanceTimersByTimeAsync(0);
    expect(client.release).toHaveBeenCalledOnce();
    expect(wake).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1000);
    expect(pool.connect).toHaveBeenCalledTimes(2);
    expect(wake).toHaveBeenCalledOnce();
    await listener.close();
    await vi.advanceTimersByTimeAsync(5000);
    expect(pool.connect).toHaveBeenCalledTimes(2);
  });
});
