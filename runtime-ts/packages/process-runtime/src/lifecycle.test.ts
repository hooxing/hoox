import { EventEmitter } from "node:events";
import { describe, expect, it } from "vitest";
import {
  installProcessSignalHandlers,
  ProcessLifecycle,
  ProcessLifecycleError,
} from "./lifecycle.js";

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

describe("进程生命周期", () => {
  it("先停止接单、等待 in-flight，再按声明顺序关闭资源", async () => {
    const events: string[] = [];
    const operation = deferred<string>();
    const lifecycle = new ProcessLifecycle({
      stopAccepting: async () => {
        events.push("stop");
      },
      resources: ["http", "postgres", "object-store"].map((name) => ({
        name,
        close: async () => {
          events.push(name);
        },
      })),
      shutdownTimeoutMilliseconds: 1_000,
    });
    const tracked = lifecycle.track(() => operation.promise);
    const firstClose = lifecycle.close();
    expect(lifecycle.close()).toBe(firstClose);
    expect(lifecycle.state).toBe("draining");
    await expect(lifecycle.track(async () => "late")).rejects.toMatchObject({
      code: "NOT_ACCEPTING",
    });
    await Promise.resolve();
    expect(events).toEqual(["stop"]);
    operation.resolve("done");
    await expect(tracked).resolves.toBe("done");
    await firstClose;
    expect(events).toEqual(["stop", "http", "postgres", "object-store"]);
    expect(lifecycle.state).toBe("closed");
    await lifecycle.close();
    expect(events).toHaveLength(4);
  });

  it("单个资源失败仍继续顺序关闭，其错误被归一化", async () => {
    const events: string[] = [];
    const lifecycle = new ProcessLifecycle({
      stopAccepting: async () => undefined,
      resources: [
        {
          name: "first",
          close: async () => {
            events.push("first");
            throw new Error("credential-canary");
          },
        },
        {
          name: "second",
          close: async () => {
            events.push("second");
          },
        },
      ],
      shutdownTimeoutMilliseconds: 1_000,
    });
    await expect(lifecycle.close()).rejects.toEqual(
      new ProcessLifecycleError("RESOURCE_CLOSE_FAILED", "first"),
    );
    expect(events).toEqual(["first", "second"]);
    expect(lifecycle.state).toBe("failed");
  });

  it("drain 超时返回稳定失败且不会被迟到完成改写为 closed", async () => {
    const operation = deferred<void>();
    const lifecycle = new ProcessLifecycle({
      stopAccepting: async () => undefined,
      resources: [],
      shutdownTimeoutMilliseconds: 20,
    });
    void lifecycle.track(() => operation.promise);
    const first = lifecycle.close();
    await expect(first).rejects.toMatchObject({ code: "SHUTDOWN_TIMEOUT" });
    await expect(lifecycle.close()).rejects.toMatchObject({ code: "SHUTDOWN_TIMEOUT" });
    expect(lifecycle.state).toBe("failed");
    operation.resolve();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(lifecycle.state).toBe("failed");
  });

  it("SIGTERM/SIGINT 和重复 dispose 共享同一个 close，不调用进程退出", async () => {
    const source = new EventEmitter();
    let stopCount = 0;
    let closeCount = 0;
    const lifecycle = new ProcessLifecycle({
      stopAccepting: async () => {
        stopCount += 1;
      },
      resources: [
        {
          name: "resource",
          close: async () => {
            closeCount += 1;
          },
        },
      ],
      shutdownTimeoutMilliseconds: 1_000,
    });
    const registration = installProcessSignalHandlers(lifecycle, { source });
    source.emit("SIGTERM");
    source.emit("SIGINT");
    await lifecycle.close();
    expect(stopCount).toBe(1);
    expect(closeCount).toBe(1);
    expect(source.listenerCount("SIGTERM")).toBe(0);
    expect(source.listenerCount("SIGINT")).toBe(0);
    registration.dispose();
    registration.dispose();
    expect(source.listenerCount("SIGTERM")).toBe(0);
    expect(source.listenerCount("SIGINT")).toBe(0);
  });

  it("stopAccepting 同步重入 close 时仍只执行一次", async () => {
    let lifecycle!: ProcessLifecycle;
    let stopCount = 0;
    let nestedClose: Promise<void> | undefined;
    lifecycle = new ProcessLifecycle({
      shutdownTimeoutMilliseconds: 100,
      stopAccepting: async () => {
        stopCount += 1;
        nestedClose = lifecycle.close();
      },
      resources: [],
    });

    const firstClose = lifecycle.close();
    await firstClose;
    expect(nestedClose).toBe(firstClose);
    expect(stopCount).toBe(1);
  });
});
