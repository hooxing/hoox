import { ApiFailure } from "./service.js";

export function safeDownloadName(name: string, artifactId: string): string {
  const normalized = Array.from(name.normalize("NFKC"))
    .map((character) =>
      /[\p{Cc}\p{Cf}]/u.test(character) || '/\\"*:<>?|'.includes(character) ? "_" : character,
    )
    .join("")
    .replace(/[. ]+$/gu, "")
    .trim();
  return (normalized.length === 0 ? `artifact-${artifactId}` : normalized).slice(0, 180);
}

export function validateFileDeliveryUrl(value: string): string {
  try {
    const url = new URL(value);
    if (
      (url.protocol !== "https:" && url.protocol !== "http:") ||
      url.username ||
      url.password ||
      !url.host
    ) {
      throw new Error("invalid artifact URL");
    }
    return url.toString();
  } catch {
    throw new ApiFailure("dependency_unavailable");
  }
}

export function isInlineBinaryPreviewMediaType(value: string): boolean {
  const [rawBase, ...rawParameters] = value.split(";");
  const base = rawBase?.trim().toLowerCase();
  return (
    rawParameters.length === 0 &&
    new Set(["image/png", "image/jpeg", "image/gif", "image/webp", "application/pdf"]).has(
      base ?? "",
    )
  );
}
