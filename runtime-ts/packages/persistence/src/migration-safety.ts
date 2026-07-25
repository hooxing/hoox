import { PersistenceError } from "./errors.js";

export function assertDestructiveMigrationAllowed(
  argv: readonly string[],
  environment: string | undefined,
): asserts environment is "development" | "test" {
  if (
    !argv.includes("--allow-destructive") ||
    (environment !== "development" && environment !== "test")
  ) {
    throw new PersistenceError(
      "CONSTRAINT_VIOLATION",
      "down 需要 --allow-destructive 且 RUNTIME_ENV 必须为 development/test",
    );
  }
}
