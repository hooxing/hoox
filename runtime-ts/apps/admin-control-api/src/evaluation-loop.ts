import type { EvaluationCommand, EvaluationCommandResult } from "@hoox/persistence/postgres";

export function evaluationCommandClient(apiUrl: string) {
  const endpoint = new URL("/internal/evaluation-command", apiUrl);
  return async ({ token, ...input }: EvaluationCommand): Promise<EvaluationCommandResult> => {
    const response = await fetch(endpoint, {
      method: "POST",
      redirect: "error",
      signal: AbortSignal.timeout(10000),
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: JSON.stringify(input),
    });
    if (response.status === 404) return "stale";
    if (!response.ok) throw new Error("评测命令响应未知");
    const payload: unknown = await response.json();
    const result =
      typeof payload === "object" && payload !== null && "status" in payload
        ? payload.status
        : undefined;
    if (
      typeof result !== "string" ||
      !["active", "succeeded", "failed", "cancelled", "not_started", "unavailable"].includes(result)
    )
      throw new Error("评测命令响应无效");
    return result as Exclude<EvaluationCommandResult, "stale">;
  };
}
export function startEvaluationLoop(driver: { tick(): Promise<boolean> }, interval: number) {
  let stopped = false,
    active: Promise<void> | undefined;
  const timer = setInterval(() => {
    if (stopped || active) return;
    active = (async () => {
      try {
        for (let i = 0; i < 32 && !stopped; i++) if (!(await driver.tick())) break;
      } catch {
        console.error("评测调度未完成，将在租约到期后重试");
      } finally {
        active = undefined;
      }
    })();
  }, interval);
  timer.unref();
  return async () => {
    stopped = true;
    clearInterval(timer);
    await active;
  };
}
