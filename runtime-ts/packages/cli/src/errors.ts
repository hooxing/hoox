export type ErrorKind = "usage" | "validation" | "authentication" | "service" | "file";
export type FieldError = { path: string; code: string; message: string };

export const exitCodes: Record<ErrorKind, number> = {
  usage: 1,
  validation: 2,
  authentication: 3,
  service: 4,
  file: 5,
};

export class CliError extends Error {
  constructor(
    readonly kind: ErrorKind,
    readonly code: string,
    message: string,
    readonly errors: readonly FieldError[] = [],
  ) {
    super(message);
  }
}
