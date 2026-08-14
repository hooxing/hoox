export interface UncertainLifecycleEvent {
  readonly kind: "sandbox_create_outcome_unknown";
  readonly stage: "create_response" | "cleanup_after_create" | "cleanup_after_reconcile";
  readonly requestId: string;
  readonly sandboxId?: string;
  readonly actualTtlSeconds: number;
  readonly occurredAt: string;
}
