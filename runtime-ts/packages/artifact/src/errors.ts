export type ArtifactDeliveryErrorCode =
  | "ARTIFACT_INVALID_ARGUMENT"
  | "ARTIFACT_NOT_FOUND"
  | "ARTIFACT_IDEMPOTENCY_CONFLICT"
  | "ARTIFACT_PUBLICATION_FAILED"
  | "ARTIFACT_NOT_READY"
  | "ARTIFACT_DEPENDENCY_UNAVAILABLE";

export class ArtifactDeliveryError extends Error {
  readonly code: ArtifactDeliveryErrorCode;

  constructor(code: ArtifactDeliveryErrorCode, message: string) {
    super(message);
    this.name = "ArtifactDeliveryError";
    this.code = code;
  }
}

export function artifactError(
  code: ArtifactDeliveryErrorCode,
  message: string,
): ArtifactDeliveryError {
  return new ArtifactDeliveryError(code, message);
}
