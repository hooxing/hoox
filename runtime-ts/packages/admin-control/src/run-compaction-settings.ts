export interface RunCompactionSettings {
  readonly softLimitPercent: number;
  readonly targetPercent: number;
  readonly recentUserTokens: number;
  readonly maxOutputTokens: number;
  readonly timeoutMs: number;
}

export interface RunCompactionSettingsPort {
  /** 首次解析固化部署参数；恢复已有 Run 时保留其已持久化参数或旧配置引用。 */
  resolveForRun(input: {
    readonly tenantId: string;
    readonly runId: string;
    readonly deploymentSettings: RunCompactionSettings;
  }): Promise<RunCompactionSettings>;
}

export function normalizeRunCompactionSettings(
  input: RunCompactionSettings,
): RunCompactionSettings {
  const settings = {
    softLimitPercent: input.softLimitPercent,
    targetPercent: input.targetPercent,
    recentUserTokens: input.recentUserTokens,
    maxOutputTokens: input.maxOutputTokens,
    timeoutMs: input.timeoutMs,
  };
  if (
    !Object.values(settings).every(Number.isSafeInteger) ||
    settings.softLimitPercent < 1 ||
    settings.softLimitPercent > 99 ||
    settings.targetPercent < 1 ||
    settings.targetPercent >= settings.softLimitPercent ||
    settings.recentUserTokens < 1 ||
    settings.recentUserTokens > 10_000_000 ||
    settings.maxOutputTokens < 1 ||
    settings.maxOutputTokens > 10_000_000 ||
    settings.timeoutMs < 1 ||
    settings.timeoutMs > 600_000
  ) {
    throw new TypeError("Run 上下文压缩参数无效");
  }
  return Object.freeze(settings);
}
