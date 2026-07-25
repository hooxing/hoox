/**
 * 单个 ExecutionAttempt 的持久操作串行器。
 *
 * 队列中的失败不会毒化后续操作；调用方仍收到原始失败。drain 只在停止新生产者后调用，
 * 用于保证 heartbeat、事件和许可事务全部退出后再释放 Session。
 */
export class DurableOperationLane {
  #tail: Promise<void> = Promise.resolve();

  run<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.#tail.then(operation, operation);
    this.#tail = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }

  async drain(): Promise<void> {
    await this.#tail;
  }
}
