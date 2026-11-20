import { runId } from "@hoox/domain";
import {
  ErrorEnvelopeSchema,
  type RunEventListQuery,
  RunEventListQuerySchema,
  RunEventPageSuccessEnvelopeSchema,
  type RunEventStreamQuery,
  RunEventStreamQuerySchema,
  type RunPath,
  RunPathSchema,
} from "@hoox/protocol";
import type { FastifyInstance } from "fastify";
import type { ApiDependencies } from "../dependencies.js";
import { success } from "../http.js";
import type { AuthenticateRequest } from "../request-auth.js";
import { openRunEventStream } from "../run-event-stream.js";
import { ApiFailure, type ApiService } from "../service.js";

export function registerRunEventRoutes(
  app: FastifyInstance,
  dependencies: Pick<ApiDependencies, "experience">,
  service: ApiService,
  authenticate: AuthenticateRequest,
): void {
  const eventStreams = new Set<AbortController>();
  let eventStreamsClosing = false;
  // 在 Fastify 等待连接关闭前中止 SSE，并阻止仍在鉴权的请求开启新流。
  app.addHook("preClose", async () => {
    eventStreamsClosing = true;
    for (const controller of eventStreams) controller.abort();
  });

  if (dependencies.experience !== undefined) {
    app.get<{ Params: RunPath; Querystring: RunEventStreamQuery }>(
      "/v1/threads/:threadId/runs/:runId/events/stream",
      {
        handlerTimeout: 45_000,
        schema: { params: RunPathSchema, querystring: RunEventStreamQuerySchema },
      },
      async (request, reply) => {
        const experience = dependencies.experience;
        if (experience === undefined) throw new ApiFailure("not_found");
        const auth = await authenticate(request);
        await service.getRun(auth, request.params.threadId, request.params.runId);
        if (eventStreamsClosing) throw new ApiFailure("dependency_unavailable");
        const controller = new AbortController();
        const abort = () => controller.abort();
        eventStreams.add(controller);
        reply.raw.once("close", abort);
        try {
          const stream = await openRunEventStream({
            cursor: request.query,
            signal: controller.signal,
            watch: (wake) =>
              experience.watchEvents?.(
                { scope: auth.scope, runId: runId(request.params.runId) },
                wake,
              ) ?? (() => {}),
            read: async (after) => {
              const currentAuth = await authenticate(request);
              const run = await service.getRun(
                currentAuth,
                request.params.threadId,
                request.params.runId,
              );
              const page = await experience.listEvents({
                scope: currentAuth.scope,
                runId: runId(run.id),
                after,
                limit: 32,
              });
              if (page.outcome === "not_found") throw new ApiFailure("not_found");
              return { run, page };
            },
            publicType: publicEventType,
          });
          stream.once("close", () => {
            eventStreams.delete(controller);
            reply.raw.removeListener("close", abort);
          });
          reply.raw.setTimeout(0, abort);
          return reply
            .header("Content-Type", "text/event-stream; charset=utf-8")
            .header("Cache-Control", "no-cache, no-transform")
            .header("X-Accel-Buffering", "no")
            .send(stream);
        } catch (error) {
          eventStreams.delete(controller);
          reply.raw.removeListener("close", abort);
          throw error;
        }
      },
    );
    app.get<{ Params: RunPath; Querystring: RunEventListQuery }>(
      "/v1/threads/:threadId/runs/:runId/events",
      {
        schema: {
          params: RunPathSchema,
          querystring: RunEventListQuerySchema,
          response: {
            200: RunEventPageSuccessEnvelopeSchema,
            400: ErrorEnvelopeSchema,
            401: ErrorEnvelopeSchema,
            404: ErrorEnvelopeSchema,
            500: ErrorEnvelopeSchema,
            503: ErrorEnvelopeSchema,
          },
        },
      },
      async (request) => {
        const auth = await authenticate(request);
        const run = await service.getRun(auth, request.params.threadId, request.params.runId);
        const read = await dependencies.experience?.listEvents({
          scope: auth.scope,
          runId: runId(run.id),
          after: request.query.after ?? -1,
          limit: request.query.limit ?? 100,
        });
        if (read === undefined || read.outcome === "not_found") throw new ApiFailure("not_found");
        return success(request, {
          ...(read.attemptId === undefined ? {} : { attemptId: read.attemptId }),
          hasMore: read.hasMore,
          items: read.events.map((event) => ({
            eventId: `${read.attemptId ?? "pending"}-${event.sequence}`,
            sequence: event.sequence,
            type: publicEventType(event.kind, event.payload),
            kind: event.kind,
            payload: event.payload,
            occurredAt: event.occurredAt,
          })),
        });
      },
    );
  }
}

const publicAgentEventTypes = new Set([
  "agent.started",
  "agent.settled",
  "thinking.started",
  "thinking.delta",
  "thinking.completed",
  "message.delta",
  "message.completed",
  "tool.started",
  "tool.updated",
  "tool.completed",
  "finalization.started",
  "finalization.cancelled",
  "final_answer.committed",
  "todo.updated",
  "queue.updated",
  "runtime.notice",
  "compaction.forbidden",
  "error",
]);

/** 仅透传已由 RuntimeAgentEvent 协议声明的 agent 子类型，未知 payload 不能伪造公开事件类型。 */
function publicEventType(kind: string, payload: Readonly<Record<string, unknown>>): string {
  if (kind !== "agent_event") return kind;
  const candidate = payload.type;
  return typeof candidate === "string" && publicAgentEventTypes.has(candidate) ? candidate : kind;
}
