// 此文件由 OpenAPI 生成；请运行 @hoox/sdk 的 types:generate，不要手工修改。
export type ErrorEnvelope = {
  version: "v1";
  requestId: string;
  error: {
    code:
      | "INVALID_REQUEST"
      | "UNSUPPORTED_MEDIA_TYPE"
      | "UNAUTHORIZED"
      | "FORBIDDEN"
      | "NOT_FOUND"
      | "CONFLICT"
      | "AGENT_REVISION_UNAVAILABLE"
      | "INVALID_STATE"
      | "RATE_LIMITED"
      | "DEPENDENCY_UNAVAILABLE"
      | "INTERNAL";
    message: string;
    retryable: boolean;
  };
  validationErrors?: Array<{ path: string; code: string; message: string }>;
};
export type AvailableAgentList = { items: Array<AvailableAgentDto> };
export type AvailableAgentDto = {
  id: string;
  displayName: string;
  description: string;
  avatarRef?: string;
  welcomeMessage?: string;
  suggestedQuestions: Array<string>;
};
export type ThreadDto = {
  id: string;
  tenantId: string;
  createdByUserId: string;
  agentDefinitionId?: string;
  title: string;
  status: "active" | "archived";
  createdAt: string;
  updatedAt: string;
};
export type ThreadPageDto = { items: Array<ThreadDto>; nextCursor?: string };
export type ThreadRunPageDto = { items: Array<RunDto> };
export type RunDto = {
  id: string;
  tenantId: string;
  threadId: string;
  status: "queued" | "running" | "waiting" | "succeeded" | "failed" | "cancelled";
  executionStatus?: "recovery_required";
  createdAt: string;
  updatedAt: string;
};
export type RunEventPageDto = { attemptId?: string; items: Array<RunEventDto>; hasMore?: boolean };
export type RunEventDto = {
  eventId: string;
  sequence: number;
  type: string;
  kind: string;
  payload: { [key: string]: unknown };
  occurredAt: string;
};
export type UploadedResourceDto = {
  resourceId: string;
  versionId: string;
  name: string;
  path: string;
  mediaType: string;
  sizeBytes: number;
};
export type ResourceDownloadDto = {
  resourceId: string;
  versionId: string;
  name: string;
  mediaType: string;
  sizeBytes: number;
  url: string;
  expiresInSeconds: number;
};
export type ArtifactListDto = { items: Array<ArtifactDto> };
export type ArtifactDto = {
  id: string;
  tenantId: string;
  threadId: string;
  runId: string;
  resourceVersionId: string;
  replacesArtifactId?: string;
  name: string;
  mediaType?: string;
  sizeBytes?: number;
  status: "publishing" | "published" | "failed";
  createdAt: string;
  updatedAt: string;
};
export type ArtifactDeliveryDto =
  | {
      artifact: {
        id: string;
        tenantId: string;
        threadId: string;
        runId: string;
        resourceVersionId: string;
        replacesArtifactId?: string;
        name: string;
        mediaType?: string;
        sizeBytes?: number;
        status: "publishing" | "published" | "failed";
        createdAt: string;
        updatedAt: string;
      };
      url: string;
      expiresInSeconds: number;
      disposition: "preview" | "download";
    }
  | ArtifactTextPreviewDto;
export type ArtifactTextPreviewDto = {
  artifact: {
    id: string;
    tenantId: string;
    threadId: string;
    runId: string;
    resourceVersionId: string;
    replacesArtifactId?: string;
    name: string;
    mediaType?: string;
    sizeBytes?: number;
    status: "publishing" | "published" | "failed";
    createdAt: string;
    updatedAt: string;
  };
  text: string;
  disposition: "preview";
};
export interface Operations {
  getRunFeedback: {
    body: never;
    query: Record<string, never>;
    response: {
      version: "v1";
      requestId: string;
      data: {
        feedback: {
          runId: string;
          revisionId: string;
          userId: string;
          rating: "up" | "down";
          comment?: string;
          createdAt: string;
          updatedAt: string;
        } | null;
      };
    };
  };
  putRunFeedback: {
    body: { rating: "up" | "down"; comment?: string };
    query: Record<string, never>;
    response: {
      version: "v1";
      requestId: string;
      data: {
        feedback: {
          runId: string;
          revisionId: string;
          userId: string;
          rating: "up" | "down";
          comment?: string;
          createdAt: string;
          updatedAt: string;
        } | null;
      };
    };
  };
  deleteRunFeedback: {
    body: never;
    query: Record<string, never>;
    response: {
      version: "v1";
      requestId: string;
      data: {
        feedback: {
          runId: string;
          revisionId: string;
          userId: string;
          rating: "up" | "down";
          comment?: string;
          createdAt: string;
          updatedAt: string;
        } | null;
      };
    };
  };
  submitToolResult: {
    body: { callId: string; outcome: "succeeded" | "failed"; result: string };
    query: Record<string, never>;
    response: { version: "v1"; requestId: string; data: { callId: string; accepted: true } };
  };
  listAgents: {
    body: never;
    query: Record<string, never>;
    response: { version: "v1"; requestId: string; data: AvailableAgentList };
  };
  createThread: {
    body: { title: string; agentDefinitionId?: string };
    query: Record<string, never>;
    response: { version: "v1"; requestId: string; data: ThreadDto };
  };
  listThreads: {
    body: never;
    query: { cursor?: string; limit?: number };
    response: { version: "v1"; requestId: string; data: ThreadPageDto };
  };
  getThread: {
    body: never;
    query: Record<string, never>;
    response: { version: "v1"; requestId: string; data: ThreadDto };
  };
  listThreadRuns: {
    body: never;
    query: { limit?: number };
    response: { version: "v1"; requestId: string; data: ThreadRunPageDto };
  };
  createRun: {
    body: { input: string; skillInvocation?: { skill: string; args?: string } };
    query: Record<string, never>;
    response: { version: "v1"; requestId: string; data: RunDto };
  };
  getRun: {
    body: never;
    query: Record<string, never>;
    response: { version: "v1"; requestId: string; data: RunDto };
  };
  cancelRun: {
    body: never;
    query: Record<string, never>;
    response: { version: "v1"; requestId: string; data: RunDto };
  };
  listRunEvents: {
    body: never;
    query: { after?: number; limit?: number };
    response: { version: "v1"; requestId: string; data: RunEventPageDto };
  };
  streamRunEvents: { body: never; query: { after?: number; attemptId?: string }; response: never };
  uploadResource: {
    body: never;
    query: Record<string, never>;
    response: { version: "v1"; requestId: string; data: UploadedResourceDto };
  };
  downloadResource: {
    body: never;
    query: Record<string, never>;
    response: { version: "v1"; requestId: string; data: ResourceDownloadDto };
  };
  listArtifacts: {
    body: never;
    query: Record<string, never>;
    response: { version: "v1"; requestId: string; data: ArtifactListDto };
  };
  previewArtifact: {
    body: never;
    query: Record<string, never>;
    response: { version: "v1"; requestId: string; data: ArtifactDeliveryDto };
  };
  downloadArtifact: {
    body: never;
    query: Record<string, never>;
    response: { version: "v1"; requestId: string; data: ArtifactDeliveryDto };
  };
  readArtifactContent: { body: never; query: Record<string, never>; response: never };
}
export const routes = {
  getRunFeedback: { method: "GET", path: "/v1/threads/{threadId}/runs/{runId}/feedback" },
  putRunFeedback: { method: "PUT", path: "/v1/threads/{threadId}/runs/{runId}/feedback" },
  deleteRunFeedback: { method: "DELETE", path: "/v1/threads/{threadId}/runs/{runId}/feedback" },
  submitToolResult: { method: "POST", path: "/v1/threads/{threadId}/runs/{runId}/tool-results" },
  listAgents: { method: "GET", path: "/v1/agents" },
  createThread: { method: "POST", path: "/v1/threads" },
  listThreads: { method: "GET", path: "/v1/threads" },
  getThread: { method: "GET", path: "/v1/threads/{threadId}" },
  listThreadRuns: { method: "GET", path: "/v1/threads/{threadId}/runs" },
  createRun: { method: "POST", path: "/v1/threads/{threadId}/runs" },
  getRun: { method: "GET", path: "/v1/threads/{threadId}/runs/{runId}" },
  cancelRun: { method: "DELETE", path: "/v1/threads/{threadId}/runs/{runId}" },
  listRunEvents: { method: "GET", path: "/v1/threads/{threadId}/runs/{runId}/events" },
  streamRunEvents: { method: "GET", path: "/v1/threads/{threadId}/runs/{runId}/events/stream" },
  uploadResource: { method: "POST", path: "/v1/resources/uploads" },
  downloadResource: {
    method: "GET",
    path: "/v1/resources/{resourceId}/versions/{versionId}/download",
  },
  listArtifacts: { method: "GET", path: "/v1/threads/{threadId}/runs/{runId}/artifacts" },
  previewArtifact: {
    method: "GET",
    path: "/v1/threads/{threadId}/runs/{runId}/artifacts/{artifactId}/preview",
  },
  downloadArtifact: {
    method: "GET",
    path: "/v1/threads/{threadId}/runs/{runId}/artifacts/{artifactId}/download",
  },
  readArtifactContent: {
    method: "GET",
    path: "/v1/threads/{threadId}/runs/{runId}/artifacts/{artifactId}/content",
  },
} as const;
