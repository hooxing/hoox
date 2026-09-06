export interface DemoReleaseGateInput {
  readonly eventName: string;
  readonly event: Readonly<Record<string, unknown>>;
  readonly repository: string;
  readonly ref: string;
  readonly sha: string;
  readonly token: string;
  readonly apiUrl?: string;
  readonly fetchImpl?: typeof fetch;
}

export function checkDemoRelease(input: DemoReleaseGateInput): Promise<{
  shouldDeploy: boolean;
  releaseSha: string;
  reason: string;
}>;
