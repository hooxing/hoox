import {
  RUN_EXPLORER_ORIGINS,
  RUN_EXPLORER_STATUSES,
  type RunExplorerOrigin,
  type RunExplorerService,
  type RunExplorerStatus,
} from "@hoox/admin-control";
import { ErrorEnvelopeSchema } from "@hoox/protocol";
import { type TSchema, Type } from "@sinclair/typebox";
import type { FastifyInstance, FastifyRequest } from "fastify";

const strict = { additionalProperties: false } as const;
const IdentifierSchema = Type.String({ pattern: "^[A-Za-z0-9][A-Za-z0-9_.:-]{0,255}$" });
const TimestampSchema = Type.String({ minLength: 1, maxLength: 64 });

const RunListQuerySchema = Type.Object(
  {
    tenantId: Type.Optional(IdentifierSchema),
    status: Type.Optional(Type.Union(RUN_EXPLORER_STATUSES.map((value) => Type.Literal(value)))),
    createdFrom: Type.Optional(TimestampSchema),
    createdTo: Type.Optional(TimestampSchema),
    agentDefinitionId: Type.Optional(IdentifierSchema),
    agentRevisionId: Type.Optional(IdentifierSchema),
    origin: Type.Optional(Type.Union(RUN_EXPLORER_ORIGINS.map((value) => Type.Literal(value)))),
    search: Type.Optional(Type.String({ minLength: 1, maxLength: 200 })),
    cursor: Type.Optional(Type.String({ minLength: 1, maxLength: 1024 })),
    limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 200, default: 50 })),
  },
  strict,
);
const RunPathSchema = Type.Object({ tenantId: IdentifierSchema, runId: IdentifierSchema }, strict);
const RunDetailQuerySchema = Type.Object({ attemptId: Type.Optional(IdentifierSchema) }, strict);

const UsageSchema = Type.Object(
  {
    inputTokens: Type.Integer({ minimum: 0 }),
    outputTokens: Type.Integer({ minimum: 0 }),
    cacheReadTokens: Type.Integer({ minimum: 0 }),
    generationDurationMs: Type.Number({ minimum: 0 }),
  },
  strict,
);
const NullableString = Type.Union([Type.String(), Type.Null()]);
const summaryProperties = {
  tenantId: Type.String(),
  runId: Type.String(),
  threadId: Type.String(),
  threadTitle: Type.String(),
  userInput: Type.Optional(Type.String()),
  userEmail: Type.Optional(Type.String()),
  userDisplayName: Type.Optional(Type.String()),
  agentDisplayName: Type.Optional(Type.String()),
  status: Type.String(),
  createdAt: Type.String(),
  updatedAt: Type.String(),
  agentDefinitionId: NullableString,
  agentRevisionId: NullableString,
  origin: NullableString,
  attemptCount: Type.Integer({ minimum: 0 }),
  latestAttemptId: Type.Optional(Type.String()),
  latestAttemptStatus: Type.Optional(Type.String()),
  startedAt: Type.Optional(Type.String()),
  finishedAt: Type.Optional(Type.String()),
  durationMs: Type.Optional(Type.Number({ minimum: 0 })),
  modelCalls: Type.Integer({ minimum: 0 }),
  toolCalls: Type.Integer({ minimum: 0 }),
  failedToolCalls: Type.Integer({ minimum: 0 }),
  errorCount: Type.Integer({ minimum: 0 }),
  usage: UsageSchema,
};
const RunSummarySchema = Type.Object(summaryProperties, strict);
const AttemptSchema = Type.Object(
  {
    attemptId: Type.String(),
    status: Type.String(),
    stage: Type.String(),
    createdAt: Type.String(),
    finishedAt: Type.Optional(Type.String()),
  },
  strict,
);
const RunRecordSchema = Type.Object(
  { ...summaryProperties, attempts: Type.Array(AttemptSchema) },
  strict,
);
const TimelineRecordSchema = Type.Object(
  {
    id: Type.String(),
    sequence: Type.Integer(),
    endSequence: Type.Integer(),
    step: Type.Optional(Type.Integer()),
    kind: Type.String(),
    event: Type.String(),
    summary: Type.String(),
    status: Type.String(),
    startedAt: Type.String(),
    completedAt: Type.Optional(Type.String()),
    durationMs: Type.Optional(Type.Number({ minimum: 0 })),
    // 结构模式只含白名单字段；正文模式原样返回事件详情。
    detail: Type.Optional(Type.Object({}, { additionalProperties: true })),
  },
  strict,
);
const TimelineSchema = Type.Object(
  {
    records: Type.Array(TimelineRecordSchema),
    stats: Type.Object(
      {
        eventCount: Type.Integer({ minimum: 0 }),
        recordCount: Type.Integer({ minimum: 0 }),
        modelSteps: Type.Integer({ minimum: 0 }),
        toolCalls: Type.Integer({ minimum: 0 }),
        failedToolCalls: Type.Integer({ minimum: 0 }),
        errors: Type.Integer({ minimum: 0 }),
        durationMs: Type.Optional(Type.Number({ minimum: 0 })),
      },
      strict,
    ),
  },
  strict,
);

function envelope(data: TSchema) {
  return Type.Object(
    { version: Type.Literal("v1"), requestId: Type.String(), data },
    { additionalProperties: false },
  );
}

const RunPageEnvelope = envelope(
  Type.Object(
    {
      items: Type.Array(RunSummarySchema),
      nextCursor: Type.Optional(Type.String()),
      contentAccess: Type.Boolean(),
    },
    strict,
  ),
);
const detailProperties = {
  run: RunRecordSchema,
  attemptId: Type.Optional(Type.String()),
  timeline: TimelineSchema,
  contentAccess: Type.Boolean(),
  auditId: Type.Optional(Type.String()),
};
const RunDetailEnvelope = envelope(Type.Object(detailProperties, strict));
const RunContentEnvelope = envelope(
  Type.Object({ ...detailProperties, auditId: Type.String() }, strict),
);

function responses(success: TSchema) {
  return {
    200: success,
    400: ErrorEnvelopeSchema,
    401: ErrorEnvelopeSchema,
    404: ErrorEnvelopeSchema,
    500: ErrorEnvelopeSchema,
    503: ErrorEnvelopeSchema,
  };
}

export type RunExplorerRouteService = Pick<
  RunExplorerService,
  "listRuns" | "getRunDetail" | "readRunContent"
>;

interface RunListQuery {
  readonly tenantId?: string;
  readonly status?: RunExplorerStatus;
  readonly createdFrom?: string;
  readonly createdTo?: string;
  readonly agentDefinitionId?: string;
  readonly agentRevisionId?: string;
  readonly origin?: RunExplorerOrigin;
  readonly search?: string;
  readonly cursor?: string;
  readonly limit?: number;
}

/**
 * 注册后台 Run 浏览器路由。列表筛选放在请求体中，避免关键词进入 URL 日志。
 */
export function registerRunExplorerRoutes(
  app: FastifyInstance,
  runs: RunExplorerRouteService,
  helpers: {
    readonly actor: (request: FastifyRequest) => Promise<string>;
    readonly success: (request: FastifyRequest, data: unknown) => unknown;
  },
): void {
  app.post<{ Body: RunListQuery }>(
    "/v1/admin/control/runs",
    { schema: { body: RunListQuerySchema, response: responses(RunPageEnvelope) } },
    async (request) =>
      helpers.success(request, await runs.listRuns(await helpers.actor(request), request.body)),
  );
  app.get<{
    Params: { readonly tenantId: string; readonly runId: string };
    Querystring: { readonly attemptId?: string };
  }>(
    "/v1/admin/control/runs/:tenantId/:runId",
    {
      schema: {
        params: RunPathSchema,
        querystring: RunDetailQuerySchema,
        response: responses(RunDetailEnvelope),
      },
    },
    async (request) =>
      helpers.success(
        request,
        await runs.getRunDetail(
          await helpers.actor(request),
          request.params.tenantId,
          request.params.runId,
          request.query.attemptId,
        ),
      ),
  );
  app.get<{
    Params: { readonly tenantId: string; readonly runId: string };
    Querystring: { readonly attemptId?: string };
  }>(
    "/v1/admin/control/runs/:tenantId/:runId/content",
    {
      schema: {
        params: RunPathSchema,
        querystring: RunDetailQuerySchema,
        response: responses(RunContentEnvelope),
      },
    },
    async (request) =>
      helpers.success(
        request,
        await runs.readRunContent(
          await helpers.actor(request),
          request.params.tenantId,
          request.params.runId,
          request.query.attemptId,
        ),
      ),
  );
}
