export class HooxError extends Error {
  override readonly name = "HooxError";

  constructor(
    message: string,
    readonly code: string,
    readonly status: number | undefined = undefined,
    readonly requestId: string | undefined = undefined,
    readonly retryable = false,
  ) {
    super(message);
  }
}
