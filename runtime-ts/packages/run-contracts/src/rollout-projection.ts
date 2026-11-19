/**
 * Runtime 持久化并审计的受控上下文投影。它不是 Pi Session 文件，也不允许携带工具结果、
 * 宿主路径或任意 Pi 内部 entry；恢复时只把经过裁剪的文本上下文重新投影给新 Session。
 */
export interface ControlledRolloutProjection {
  readonly schemaVersion: 2;
  readonly checkpointId: string;
  readonly items: readonly (
    | { readonly kind: "turn"; readonly role: "user" | "assistant"; readonly text: string }
    | {
        readonly kind: "tool_receipt";
        readonly toolCallId: string;
        readonly toolName: string;
        readonly outcome: "succeeded" | "failed";
        readonly observation: string;
        readonly isTruncated: boolean;
        readonly modelVisibleBytes: number;
        readonly reason?: "model_utf8_budget_or_rollout_body_budget";
      }
  )[];
}
