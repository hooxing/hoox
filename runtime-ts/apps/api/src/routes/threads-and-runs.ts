import { threadId } from "@hoox/domain";
import type { ThreadContextReadPort } from "@hoox/persistence/postgres";
import {
  type CreateRunRequest,
  CreateRunRequestSchema,
  type CreateThreadInputRequest,
  CreateThreadInputRequestSchema,
  type CreateThreadRequest,
  CreateThreadRequestSchema,
  ErrorEnvelopeSchema,
  type ForkThreadRequest,
  ForkThreadRequestSchema,
  type RenamePersonalThreadRequest,
  RenamePersonalThreadRequestSchema,
  type RunPath,
  RunPathSchema,
  RunSuccessEnvelopeSchema,
  type ThreadContextListQuery,
  ThreadContextListQuerySchema,
  ThreadContextPageSuccessEnvelopeSchema,
  ThreadContinuityStatusSuccessEnvelopeSchema,
  ThreadForkSuccessEnvelopeSchema,
  type ThreadInputReceiptPath,
  ThreadInputReceiptPathSchema,
  ThreadInputReceiptSuccessEnvelopeSchema,
  type ThreadListQuery,
  ThreadListQuerySchema,
  ThreadPageSuccessEnvelopeSchema,
  type ThreadPath,
  ThreadPathSchema,
  type ThreadRunListQuery,
  ThreadRunListQuerySchema,
  ThreadRunPageSuccessEnvelopeSchema,
  ThreadSuccessEnvelopeSchema,
} from "@hoox/protocol";
import {
  attachmentReferencesFromUserPrompt,
  ResourceServiceError,
  stripAttachmentsFromUserFacingPrompt,
} from "@hoox/resource";
import type { FastifyInstance } from "fastify";
import type { ApiCreateCapability } from "../capabilities.js";
import type { ApiDependencies } from "../dependencies.js";
import { requireIdempotencyKey, requireJsonContentType, success } from "../http.js";
import type { AuthenticateRequest, AuthenticateSelectedTenant } from "../request-auth.js";
import { ApiFailure, type ApiService } from "../service.js";

export function registerThreadAndRunRoutes(
  app: FastifyInstance,
  dependencies: Pick<
    ApiDependencies,
    "resourceAttachments" | "threadContext" | "threadContinuity" | "threadForks"
  >,
  createCapability: ApiCreateCapability | undefined,
  service: ApiService,
  authenticate: AuthenticateRequest,
  authenticateSelectedTenant: AuthenticateSelectedTenant,
): void {
  if (createCapability !== undefined) {
    app.post<{ Body: CreateThreadRequest }>(
      "/v1/threads",
      {
        preValidation: async (request) => requireJsonContentType(request),
        schema: {
          body: CreateThreadRequestSchema,
          response: {
            200: ThreadSuccessEnvelopeSchema,
            400: ErrorEnvelopeSchema,
            401: ErrorEnvelopeSchema,
            403: ErrorEnvelopeSchema,
            404: ErrorEnvelopeSchema,
            409: ErrorEnvelopeSchema,
            415: ErrorEnvelopeSchema,
            500: ErrorEnvelopeSchema,
            503: ErrorEnvelopeSchema,
          },
        },
      },
      async (request) => {
        const auth = await authenticate(request, "threads:create");
        return success(
          request,
          await service.createThread(
            auth,
            request.body.title,
            requireIdempotencyKey(request),
            request.body.agentDefinitionId,
          ),
        );
      },
    );

    const threadForks = dependencies.threadForks;
    const forkContext = dependencies.threadContext;
    if (threadForks !== undefined && forkContext !== undefined) {
      app.post<{ Params: ThreadPath; Body: ForkThreadRequest }>(
        "/v1/threads/:threadId/forks",
        {
          preValidation: async (request) => requireJsonContentType(request),
          schema: {
            params: ThreadPathSchema,
            body: ForkThreadRequestSchema,
            response: {
              200: ThreadForkSuccessEnvelopeSchema,
              400: ErrorEnvelopeSchema,
              401: ErrorEnvelopeSchema,
              403: ErrorEnvelopeSchema,
              404: ErrorEnvelopeSchema,
              409: ErrorEnvelopeSchema,
              415: ErrorEnvelopeSchema,
              422: ErrorEnvelopeSchema,
              500: ErrorEnvelopeSchema,
              503: ErrorEnvelopeSchema,
            },
          },
        },
        async (request) => {
          const sourceAuth = await authenticate(request);
          const source = await service.getThread(sourceAuth, request.params.threadId);
          const targetAuth =
            request.body.targetTeamId === undefined
              ? sourceAuth
              : await authenticateSelectedTenant(request, request.body.targetTeamId);
          if (request.body.targetTeamId !== undefined && targetAuth.tenant.tenant.kind !== "team") {
            throw new ApiFailure("not_found");
          }
          const kind =
            targetAuth.scope.tenantId === sourceAuth.scope.tenantId
              ? ("branch" as const)
              : ("team_publish" as const);
          const messages = await readForkMessages(
            forkContext,
            sourceAuth.scope,
            threadId(source.id),
          );
          const title = request.body.title?.trim() || `${source.title} · 分支`;
          const child = await service.createThread(
            targetAuth,
            title,
            requireIdempotencyKey(request),
          );
          const seeded = await threadForks.seed({
            scope: targetAuth.scope,
            childThreadId: threadId(child.id),
            sourceTenantId: sourceAuth.scope.tenantId,
            sourceThreadId: threadId(source.id),
            kind,
            messages,
          });
          if (seeded === "conflict") throw new ApiFailure("conflict");
          if (seeded !== "seeded") throw new ApiFailure("not_found");
          return success(request, child);
        },
      );
    }

    app.post<{ Params: ThreadPath; Body: CreateRunRequest }>(
      "/v1/threads/:threadId/runs",
      {
        preValidation: async (request) => requireJsonContentType(request),
        schema: {
          params: ThreadPathSchema,
          body: CreateRunRequestSchema,
          response: {
            200: RunSuccessEnvelopeSchema,
            400: ErrorEnvelopeSchema,
            401: ErrorEnvelopeSchema,
            403: ErrorEnvelopeSchema,
            404: ErrorEnvelopeSchema,
            409: ErrorEnvelopeSchema,
            415: ErrorEnvelopeSchema,
            422: ErrorEnvelopeSchema,
            500: ErrorEnvelopeSchema,
            503: ErrorEnvelopeSchema,
          },
        },
      },
      async (request) => {
        const auth = await authenticate(request, "runs:create");
        return success(
          request,
          await service.createRun(
            auth,
            request.params.threadId,
            request.body.input,
            requireIdempotencyKey(request),
            request.body.skillInvocation,
          ),
        );
      },
    );

    if (createCapability.threadInputs !== undefined) {
      app.post<{ Params: ThreadPath; Body: CreateThreadInputRequest }>(
        "/v1/threads/:threadId/inputs",
        {
          preValidation: async (request) => requireJsonContentType(request),
          schema: {
            params: ThreadPathSchema,
            body: CreateThreadInputRequestSchema,
            response: {
              200: ThreadInputReceiptSuccessEnvelopeSchema,
              400: ErrorEnvelopeSchema,
              401: ErrorEnvelopeSchema,
              403: ErrorEnvelopeSchema,
              404: ErrorEnvelopeSchema,
              409: ErrorEnvelopeSchema,
              415: ErrorEnvelopeSchema,
              422: ErrorEnvelopeSchema,
              500: ErrorEnvelopeSchema,
              503: ErrorEnvelopeSchema,
            },
          },
        },
        async (request) => {
          const auth = await authenticate(request);
          return success(
            request,
            await service.submitThreadInput(
              auth,
              request.params.threadId,
              request.body,
              requireIdempotencyKey(request),
            ),
          );
        },
      );

      app.get<{ Params: ThreadInputReceiptPath }>(
        "/v1/threads/:threadId/inputs/:receiptId",
        {
          schema: {
            params: ThreadInputReceiptPathSchema,
            response: {
              200: ThreadInputReceiptSuccessEnvelopeSchema,
              400: ErrorEnvelopeSchema,
              401: ErrorEnvelopeSchema,
              403: ErrorEnvelopeSchema,
              404: ErrorEnvelopeSchema,
              500: ErrorEnvelopeSchema,
              503: ErrorEnvelopeSchema,
            },
          },
        },
        async (request) => {
          const auth = await authenticate(request);
          return success(
            request,
            await service.getThreadInputReceipt(
              auth,
              request.params.threadId,
              request.params.receiptId,
            ),
          );
        },
      );
    }
  }

  app.get<{ Querystring: ThreadListQuery }>(
    "/v1/threads",
    {
      schema: {
        querystring: ThreadListQuerySchema,
        response: {
          200: ThreadPageSuccessEnvelopeSchema,
          400: ErrorEnvelopeSchema,
          401: ErrorEnvelopeSchema,
          403: ErrorEnvelopeSchema,
          404: ErrorEnvelopeSchema,
          500: ErrorEnvelopeSchema,
          503: ErrorEnvelopeSchema,
        },
      },
    },
    async (request) => {
      const auth = await authenticate(request, "threads:read");
      return success(request, await service.listThreads(auth, request.query));
    },
  );

  app.get<{ Params: ThreadPath }>(
    "/v1/threads/:threadId",
    {
      schema: {
        params: ThreadPathSchema,
        response: {
          200: ThreadSuccessEnvelopeSchema,
          400: ErrorEnvelopeSchema,
          401: ErrorEnvelopeSchema,
          403: ErrorEnvelopeSchema,
          404: ErrorEnvelopeSchema,
          500: ErrorEnvelopeSchema,
          503: ErrorEnvelopeSchema,
        },
      },
    },
    async (request) => {
      const auth = await authenticate(request, "threads:read");
      return success(request, await service.getThread(auth, request.params.threadId));
    },
  );

  app.patch<{ Params: ThreadPath; Body: RenamePersonalThreadRequest }>(
    "/v1/threads/:threadId",
    {
      preValidation: async (request) => requireJsonContentType(request),
      schema: {
        params: ThreadPathSchema,
        body: RenamePersonalThreadRequestSchema,
        response: {
          200: ThreadSuccessEnvelopeSchema,
          400: ErrorEnvelopeSchema,
          401: ErrorEnvelopeSchema,
          403: ErrorEnvelopeSchema,
          404: ErrorEnvelopeSchema,
          415: ErrorEnvelopeSchema,
          500: ErrorEnvelopeSchema,
          503: ErrorEnvelopeSchema,
        },
      },
    },
    async (request) => {
      const auth = await authenticate(request);
      return success(
        request,
        await service.renamePersonalThread(auth, request.params.threadId, request.body.title),
      );
    },
  );

  app.delete<{ Params: ThreadPath }>(
    "/v1/threads/:threadId",
    {
      schema: {
        params: ThreadPathSchema,
        response: {
          200: ThreadSuccessEnvelopeSchema,
          400: ErrorEnvelopeSchema,
          401: ErrorEnvelopeSchema,
          403: ErrorEnvelopeSchema,
          404: ErrorEnvelopeSchema,
          409: ErrorEnvelopeSchema,
          500: ErrorEnvelopeSchema,
          503: ErrorEnvelopeSchema,
        },
      },
    },
    async (request) => {
      const auth = await authenticate(request);
      return success(request, await service.archiveThread(auth, request.params.threadId));
    },
  );

  app.get<{ Params: ThreadPath; Querystring: ThreadRunListQuery }>(
    "/v1/threads/:threadId/runs",
    {
      schema: {
        params: ThreadPathSchema,
        querystring: ThreadRunListQuerySchema,
        response: {
          200: ThreadRunPageSuccessEnvelopeSchema,
          400: ErrorEnvelopeSchema,
          401: ErrorEnvelopeSchema,
          403: ErrorEnvelopeSchema,
          404: ErrorEnvelopeSchema,
          500: ErrorEnvelopeSchema,
          503: ErrorEnvelopeSchema,
        },
      },
    },
    async (request) => {
      const auth = await authenticate(request, "runs:read");
      return success(
        request,
        await service.listLatestRuns(auth, request.params.threadId, request.query),
      );
    },
  );

  app.get<{ Params: RunPath }>(
    "/v1/threads/:threadId/runs/:runId",
    {
      schema: {
        params: RunPathSchema,
        response: {
          200: RunSuccessEnvelopeSchema,
          400: ErrorEnvelopeSchema,
          401: ErrorEnvelopeSchema,
          403: ErrorEnvelopeSchema,
          404: ErrorEnvelopeSchema,
          500: ErrorEnvelopeSchema,
          503: ErrorEnvelopeSchema,
        },
      },
    },
    async (request) => {
      const auth = await authenticate(request, "runs:read");
      return success(
        request,
        await service.getRun(auth, request.params.threadId, request.params.runId),
      );
    },
  );

  app.delete<{ Params: RunPath }>(
    "/v1/threads/:threadId/runs/:runId",
    {
      schema: {
        params: RunPathSchema,
        response: {
          200: RunSuccessEnvelopeSchema,
          400: ErrorEnvelopeSchema,
          401: ErrorEnvelopeSchema,
          403: ErrorEnvelopeSchema,
          404: ErrorEnvelopeSchema,
          409: ErrorEnvelopeSchema,
          422: ErrorEnvelopeSchema,
          500: ErrorEnvelopeSchema,
          503: ErrorEnvelopeSchema,
        },
      },
    },
    async (request) => {
      const auth = await authenticate(request, "runs:create");
      return success(
        request,
        await service.cancelRun(auth, request.params.threadId, request.params.runId),
      );
    },
  );

  if (dependencies.threadContext !== undefined) {
    app.get<{ Params: ThreadPath; Querystring: ThreadContextListQuery }>(
      "/v1/threads/:threadId/context",
      {
        schema: {
          params: ThreadPathSchema,
          querystring: ThreadContextListQuerySchema,
          response: {
            200: ThreadContextPageSuccessEnvelopeSchema,
            400: ErrorEnvelopeSchema,
            401: ErrorEnvelopeSchema,
            403: ErrorEnvelopeSchema,
            404: ErrorEnvelopeSchema,
            500: ErrorEnvelopeSchema,
            503: ErrorEnvelopeSchema,
          },
        },
      },
      async (request) => {
        const auth = await authenticate(request);
        const read = await dependencies.threadContext?.listMessages({
          scope: auth.scope,
          threadId: threadId(request.params.threadId),
          after: request.query.after ?? 0,
          limit: request.query.limit ?? 100,
        });
        if (read === undefined || read.outcome === "not_found") throw new ApiFailure("not_found");
        const items = await Promise.all(
          read.items.map(async (item) => {
            if (item.role !== "user") return item;
            const references = attachmentReferencesFromUserPrompt(item.text);
            const attachments =
              dependencies.resourceAttachments === undefined
                ? []
                : (
                    await Promise.all(
                      references.map(async (attachment) => {
                        try {
                          return (
                            await dependencies.resourceAttachments?.resolve({
                              context: auth.scope,
                              attachments: [attachment],
                            })
                          )?.[0];
                        } catch (error) {
                          // 历史消息正文仍需可读；已删除或失去可见性的附件只从展示投影中省略。
                          if (error instanceof ResourceServiceError && error.code === "NOT_FOUND") {
                            return undefined;
                          }
                          throw error;
                        }
                      }),
                    )
                  )
                    .filter((attachment) => attachment !== undefined)
                    .map(({ resourceId, versionId, name, mediaType, sizeBytes }) => ({
                      resourceId,
                      versionId,
                      name,
                      mediaType,
                      sizeBytes,
                    }));
            return {
              ...item,
              text: stripAttachmentsFromUserFacingPrompt(item.text),
              ...(attachments.length === 0 ? {} : { attachments }),
            };
          }),
        );
        return success(request, { items, hasMore: read.hasMore });
      },
    );
  }

  if (dependencies.threadContinuity !== undefined) {
    app.get<{ Params: ThreadPath }>(
      "/v1/threads/:threadId/continuity",
      {
        schema: {
          params: ThreadPathSchema,
          response: {
            200: ThreadContinuityStatusSuccessEnvelopeSchema,
            400: ErrorEnvelopeSchema,
            401: ErrorEnvelopeSchema,
            403: ErrorEnvelopeSchema,
            404: ErrorEnvelopeSchema,
            500: ErrorEnvelopeSchema,
            503: ErrorEnvelopeSchema,
          },
        },
      },
      async (request) => {
        const auth = await authenticate(request);
        const read = await dependencies.threadContinuity?.getStatus({
          scope: auth.scope,
          threadId: threadId(request.params.threadId),
        });
        if (read === undefined || read.outcome === "not_found") throw new ApiFailure("not_found");
        return success(request, read.status);
      },
    );
  }
}

async function readForkMessages(
  reader: ThreadContextReadPort,
  scope: Readonly<{
    tenantId: import("@hoox/domain").TenantId;
    userId: import("@hoox/domain").UserId;
  }>,
  sourceThreadId: import("@hoox/domain").ThreadId,
) {
  const messages: Array<{
    role: "user" | "assistant";
    text: string;
    createdAt: string;
  }> = [];
  let after = 0;
  for (let page = 0; page < 10; page += 1) {
    const result = await reader.listMessages({
      scope,
      threadId: sourceThreadId,
      after,
      limit: 500,
    });
    if (result.outcome === "not_found") throw new ApiFailure("not_found");
    for (const item of result.items) {
      if (item.role === "runtime") continue;
      messages.push({ role: item.role, text: item.text, createdAt: item.createdAt });
    }
    const tail = result.items.at(-1);
    if (!result.hasMore) return Object.freeze(messages);
    if (tail === undefined) throw new ApiFailure("internal");
    after = tail.sequence;
  }
  // 首个试验版本拒绝复制超大上下文，避免在 HTTP 请求内制造无界事务。
  throw new ApiFailure("invalid_state");
}
