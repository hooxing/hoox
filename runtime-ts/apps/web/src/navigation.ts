export type NavigationGeneration = {
  readonly selectedThreadId: string | undefined;
  readonly generation: number;
};

/**
 * 同步导航代次：异步命令只能更新发起时仍被选中的 Thread。
 * 即使用户切走后又选回同一 Thread，旧命令也不能跨越这次导航边界写回状态。
 */
export class WorkspaceNavigation {
  #generation = 0;
  #selectedThreadId: string | undefined;

  capture(): NavigationGeneration {
    return Object.freeze({
      selectedThreadId: this.#selectedThreadId,
      generation: this.#generation,
    });
  }

  navigate(selectedThreadId: string | undefined): NavigationGeneration {
    this.#generation += 1;
    this.#selectedThreadId = selectedThreadId;
    return this.capture();
  }

  isCurrent(expected: NavigationGeneration): boolean {
    return (
      expected.generation === this.#generation &&
      expected.selectedThreadId === this.#selectedThreadId
    );
  }

  isSelected(threadId: string): boolean {
    return this.#selectedThreadId === threadId;
  }
}

/**
 * UI 恢复命令的共同闩锁：请求前 capture，响应后用它确认仍是同一导航代次。
 * Reducer 还会以 selectionGeneration 复验，避免调用点遗漏检查时让旧响应覆盖新选择。
 */
export async function recoverLatestRunForNavigation<T>(
  navigation: WorkspaceNavigation,
  expected: NavigationGeneration,
  load: () => Promise<T>,
): Promise<T | undefined> {
  const value = await load();
  return navigation.isCurrent(expected) ? value : undefined;
}
