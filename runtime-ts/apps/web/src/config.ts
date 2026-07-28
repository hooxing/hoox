export function resolveApiTarget(
  environment: Readonly<Record<string, string | undefined>>,
): string {
  return environment.VITE_WEB_API_TARGET ?? environment.WEB_API_TARGET ?? "http://127.0.0.1:3001";
}
