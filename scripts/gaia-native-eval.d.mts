export interface GaiaQuestion {
  readonly task_id: string;
  readonly question: string;
  readonly Level?: string;
  readonly level?: string;
  readonly file_name?: string;
}

export interface GaiaEvalOptions {
  readonly apiBaseUrl: string;
  readonly authToken: string;
  readonly questionsUrl: string;
  readonly filesBaseUrl: string;
  readonly limit: number;
  readonly pollIntervalMs: number;
  readonly taskTimeoutMs: number;
  readonly outputDirectory: string;
  readonly taskIds: readonly string[];
}

export interface GaiaEvalResult {
  readonly taskId: string;
  readonly status: string;
  readonly answer?: string;
  readonly threadId?: string;
  readonly runId?: string;
  readonly error?: string;
}

export function parseGaiaEvalArguments(
  argv: readonly string[],
  environment?: Readonly<Record<string, string | undefined>>,
): GaiaEvalOptions;
export function assertNativeEvalEnvironment(
  environment?: Readonly<Record<string, string | undefined>>,
): void;
export function selectGaiaQuestions(
  questions: readonly GaiaQuestion[],
  options: Pick<GaiaEvalOptions, "limit" | "taskIds">,
): GaiaQuestion[];
export function extractFinalAnswer(
  contextMessages: readonly unknown[],
  events: readonly unknown[],
): string;
export function evaluationStatus(run: {
  readonly status: string;
  readonly executionStatus?: string;
}): string;

export class GaiaRuntimeClient {
  constructor(options: GaiaEvalOptions, fetchImplementation?: typeof fetch);
}

export function runGaiaNativeEvaluation(
  options: GaiaEvalOptions,
  dependencyOverrides?: Readonly<Record<string, unknown>>,
): Promise<{
  readonly report: {
    readonly results: readonly GaiaEvalResult[];
  };
  readonly outputPath: string;
}>;
