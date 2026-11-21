export type PlaygroundMockMap = Readonly<Record<string, unknown>>;

export function playgroundMockFor(
  origin: "normal" | "playground" | "evaluation" | "api",
  mocks: PlaygroundMockMap,
  toolName: string,
): { readonly matched: false } | { readonly matched: true; readonly value: unknown } {
  if (origin !== "playground" || !Object.hasOwn(mocks, toolName)) return { matched: false };
  return { matched: true, value: mocks[toolName] };
}
