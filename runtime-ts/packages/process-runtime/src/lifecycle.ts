export type ProcessLifecycleState = "accepting" | "draining" | "closing" | "closed" | "failed";

export class ProcessLifecycleError extends Error {
  constructor(
    readonly code:
      | "NOT_ACCEPTING"
      | "SHUTDOWN_TIMEOUT"
      | "STOP_ACCEPTING_FAILED"
      | "RESOURCE_CLOSE_FAILED",
    readonly target?: string,
  ) {
    super(target === undefined ? code : `${code}:${target}`);
    this.name = "ProcessLifecycleError";
  }
}

export interface ShutdownResource {
  readonly name: string;
  close(): Promise<void>;
}

export interface ProcessLifecycleOptions {
  readonly stopAccepting: () => Promise<void>;
  /** 数组顺序就是关闭顺序，调用方必须按依赖关系显式排列。 */
  readonly resources: readonly ShutdownResource[];
  readonly shutdownTimeoutMilliseconds: number;
}

const resourceNamePattern = /^[a-z][a-z0-9_-]{0,63}$/u;

export class ProcessLifecycle {
  private currentState: ProcessLifecycleState = "accepting";
  private readonly stopAccepting: () => Promise<void>;
  private readonly resources: readonly ShutdownResource[];
  private readonly shutdownTimeoutMilliseconds: number;
  private readonly inFlight = new Set<Promise<unknown>>();
  private drainPromise: Promise<void> | undefined;
  private releaseDrain: (() => void) | undefined;
  private closePromise: Promise<void> | undefined;
  private shutdownTimedOut = false;

  constructor(options: ProcessLifecycleOptions) {
    if (
      !Number.isSafeInteger(options.shutdownTimeoutMilliseconds) ||
      options.shutdownTimeoutMilliseconds < 1 ||
      options.shutdownTimeoutMilliseconds > 10 * 60_000
    ) {
      throw new TypeError("进程关闭超时必须在 1 毫秒到 10 分钟之间");
    }
    this.shutdownTimeoutMilliseconds = options.shutdownTimeoutMilliseconds;
    if (typeof options.stopAccepting !== "function") throw new TypeError("停止接收函数无效");
    this.stopAccepting = options.stopAccepting.bind(options);
    const names = new Set<string>();
    const resources: ShutdownResource[] = [];
    for (const resource of options.resources) {
      if (
        typeof resource?.name !== "string" ||
        typeof resource.close !== "function" ||
        !resourceNamePattern.test(resource.name) ||
        names.has(resource.name)
      ) {
        throw new TypeError("关闭资源名称无效或重复");
      }
      names.add(resource.name);
      // 捕获名称与函数本身，调用方后续替换数组、对象字段都不能改变关闭计划。
      resources.push(Object.freeze({ name: resource.name, close: resource.close.bind(resource) }));
    }
    this.resources = Object.freeze(resources);
  }

  get state(): ProcessLifecycleState {
    return this.currentState;
  }

  get accepting(): boolean {
    return this.currentState === "accepting";
  }

  get inFlightCount(): number {
    return this.inFlight.size;
  }

  track<T>(operation: () => Promise<T>): Promise<T> {
    if (!this.accepting) return Promise.reject(new ProcessLifecycleError("NOT_ACCEPTING"));
    let tracked!: Promise<T>;
    try {
      tracked = Promise.resolve(operation());
    } catch (error) {
      tracked = Promise.reject(error);
    }
    this.inFlight.add(tracked);
    const finish = () => {
      this.inFlight.delete(tracked);
      if (this.inFlight.size === 0) this.releaseDrain?.();
    };
    void tracked.then(finish, finish);
    return tracked;
  }

  close(): Promise<void> {
    if (this.closePromise !== undefined) return this.closePromise;
    this.currentState = "draining";
    // 延后一轮微任务再进入用户提供的 stopAccepting，保证同步重入 close 也只启动一次清理。
    const cleanup = Promise.resolve().then(() => this.runCleanup());
    this.closePromise = this.withTimeout(cleanup);
    return this.closePromise;
  }

  private async runCleanup(): Promise<void> {
    let failure: ProcessLifecycleError | undefined;
    try {
      await this.stopAccepting();
    } catch {
      failure = new ProcessLifecycleError("STOP_ACCEPTING_FAILED");
    }

    if (this.inFlight.size > 0) {
      this.drainPromise ??= new Promise<void>((resolve) => {
        this.releaseDrain = resolve;
      });
      await this.drainPromise;
    }

    if (!this.shutdownTimedOut) this.currentState = "closing";
    for (const resource of this.resources) {
      try {
        await resource.close();
      } catch {
        failure ??= new ProcessLifecycleError("RESOURCE_CLOSE_FAILED", resource.name);
      }
    }
    if (!this.shutdownTimedOut) this.currentState = failure === undefined ? "closed" : "failed";
    if (failure !== undefined) throw failure;
  }

  private async withTimeout(cleanup: Promise<void>): Promise<void> {
    let timer: NodeJS.Timeout | undefined;
    const timeout = new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => {
        this.shutdownTimedOut = true;
        this.currentState = "failed";
        reject(new ProcessLifecycleError("SHUTDOWN_TIMEOUT"));
      }, this.shutdownTimeoutMilliseconds);
    });
    try {
      await Promise.race([cleanup, timeout]);
    } finally {
      if (timer !== undefined) clearTimeout(timer);
    }
  }
}

export interface ProcessSignalSource {
  on(signal: "SIGTERM" | "SIGINT", listener: () => void): void;
  off(signal: "SIGTERM" | "SIGINT", listener: () => void): void;
}

export interface ProcessSignalRegistration {
  dispose(): void;
}

function reportShutdownFailure(
  callback: ((error: ProcessLifecycleError) => void) | undefined,
  error: ProcessLifecycleError,
): void {
  try {
    // void 类型回调在 JavaScript 中仍可能返回被拒绝的 Promise；必须主动吸收。
    void Promise.resolve(callback?.(error)).catch(() => undefined);
  } catch {
    // 同步日志器异常同样不能制造未处理 rejection 或打断资源清理。
  }
}

/** 信号只触发同一个幂等 close；失败交给调用方记录，不调用 process.exit 截断清理。 */
export function installProcessSignalHandlers(
  lifecycle: ProcessLifecycle,
  options: {
    readonly source?: ProcessSignalSource;
    readonly onFailure?: (error: ProcessLifecycleError) => void;
  } = {},
): ProcessSignalRegistration {
  const source = options.source ?? process;
  let disposed = false;
  const dispose = () => {
    if (disposed) return;
    disposed = true;
    source.off("SIGTERM", listener);
    source.off("SIGINT", listener);
  };
  const listener = () => {
    void lifecycle.close().then(dispose, (error: unknown) => {
      reportShutdownFailure(
        options.onFailure,
        error instanceof ProcessLifecycleError
          ? error
          : new ProcessLifecycleError("RESOURCE_CLOSE_FAILED"),
      );
      dispose();
    });
  };
  source.on("SIGTERM", listener);
  source.on("SIGINT", listener);
  return Object.freeze({
    dispose,
  });
}
