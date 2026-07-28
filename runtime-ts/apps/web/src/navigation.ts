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
