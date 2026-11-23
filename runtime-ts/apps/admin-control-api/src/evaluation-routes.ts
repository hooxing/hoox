import {
  EvaluationSuiteSchema,
  EvaluationComparisonSchema,
  EvaluationRunDetailSchema,
  EvaluationRunRequestSchema,
  EvaluationRunSummarySchema,
  IdSchema,
  successEnvelopeSchema,
  type EvaluationComparison,
  type EvaluationRunDetail,
  type EvaluationRunRequest,
  type EvaluationRunSummary,
  type EvaluationSuite,
} from "@hoox/protocol";
import type { TSchema } from "@sinclair/typebox";
import { Type } from "@sinclair/typebox";
import type { FastifyInstance, FastifyRequest } from "fastify";

const base = "/v1/admin/control/agent-definitions/:definitionId/evaluations";
const path = Type.Object({ definitionId: IdSchema }, { additionalProperties: false });
const evaluationSuitePath = Type.Object(
  { definitionId: IdSchema, suiteId: IdSchema },
  { additionalProperties: false },
);
const evaluationRunPath = Type.Object(
  { definitionId: IdSchema, runId: IdSchema },
  { additionalProperties: false },
);
const compareQuery = Type.Object(
  { leftRunId: IdSchema, rightRunId: IdSchema },
  { additionalProperties: false },
);
export interface EvaluationAdminPort {
  listSuites(actorUserId: string, definitionId: string): Promise<readonly EvaluationSuite[]>;
  saveSuite(actorUserId: string, suite: EvaluationSuite): Promise<void>;
  deleteSuite(actorUserId: string, suiteId: string): Promise<void>;
  startRun(
    actorUserId: string,
    input: EvaluationRunRequest & { readonly suiteId: string },
  ): Promise<EvaluationRunSummary>;
  listRuns(actorUserId: string, definitionId: string): Promise<readonly EvaluationRunSummary[]>;
  readRun(actorUserId: string, runId: string): Promise<EvaluationRunDetail | undefined>;
  cancelRun(actorUserId: string, runId: string): Promise<boolean>;
  compareRuns(
    actorUserId: string,
    leftRunId: string,
    rightRunId: string,
  ): Promise<EvaluationComparison | undefined>;
}

export function registerEvaluationRoutes(
  app: FastifyInstance,
  evaluations: EvaluationAdminPort,
  helpers: {
    actor(request: FastifyRequest): Promise<string>;
    success(request: FastifyRequest, data: unknown): unknown;
    requireJson(request: FastifyRequest): void;
    responseSchemas(schema: object): object;
    notFound(): never;
  },
): void {
  const response = (schema: TSchema) => helpers.responseSchemas(successEnvelopeSchema(schema));
  app.get<{ Params: { definitionId: string } }>(
    base,
    {
      schema: { params: path, response: response(Type.Array(EvaluationSuiteSchema)) },
    },
    async (request) =>
      helpers.success(
        request,
        await evaluations.listSuites(await helpers.actor(request), request.params.definitionId),
      ),
  );
  app.put<{ Params: { definitionId: string }; Body: EvaluationSuite }>(
    base,
    {
      preValidation: async (request) => {
        helpers.requireJson(request);
      },
      schema: { params: path, body: EvaluationSuiteSchema, response: response(Type.Null()) },
    },
    async (request, reply) => {
      if (request.body.definitionId !== request.params.definitionId) return helpers.notFound();
      await evaluations.saveSuite(await helpers.actor(request), request.body);
      return reply.send(helpers.success(request, null));
    },
  );
  app.delete<{ Params: { definitionId: string; suiteId: string } }>(
    `${base}/:suiteId`,
    {
      schema: { params: evaluationSuitePath, response: response(Type.Null()) },
    },
    async (request) => {
      await evaluations.deleteSuite(await helpers.actor(request), request.params.suiteId);
      return helpers.success(request, null);
    },
  );
  app.post<{
    Params: { definitionId: string; suiteId: string };
    Body: EvaluationRunRequest;
  }>(
    `${base}/:suiteId/runs`,
    {
      preValidation: async (request) => helpers.requireJson(request),
      schema: {
        params: evaluationSuitePath,
        body: EvaluationRunRequestSchema,
        response: response(EvaluationRunSummarySchema),
      },
    },
    async (request) =>
      helpers.success(
        request,
        await evaluations.startRun(await helpers.actor(request), {
          ...request.body,
          suiteId: request.params.suiteId,
        }),
      ),
  );
  app.get<{ Params: { definitionId: string } }>(
    `${base}/runs`,
    {
      schema: { params: path, response: response(Type.Array(EvaluationRunSummarySchema)) },
    },
    async (request) =>
      helpers.success(
        request,
        await evaluations.listRuns(await helpers.actor(request), request.params.definitionId),
      ),
  );
  app.get<{ Params: { definitionId: string; runId: string } }>(
    `${base}/runs/:runId`,
    {
      schema: {
        params: evaluationRunPath,
        response: response(EvaluationRunDetailSchema),
      },
    },
    async (request) => {
      const result = await evaluations.readRun(await helpers.actor(request), request.params.runId);
      if (!result || result.run.definitionId !== request.params.definitionId)
        return helpers.notFound();
      return helpers.success(request, result);
    },
  );
  app.delete<{ Params: { definitionId: string; runId: string } }>(
    `${base}/runs/:runId`,
    {
      schema: { params: evaluationRunPath, response: response(Type.Boolean()) },
    },
    async (request) => {
      const existing = await evaluations.readRun(
        await helpers.actor(request),
        request.params.runId,
      );
      if (!existing || existing.run.definitionId !== request.params.definitionId)
        return helpers.notFound();
      return helpers.success(
        request,
        await evaluations.cancelRun(await helpers.actor(request), request.params.runId),
      );
    },
  );
  app.get<{
    Params: { definitionId: string };
    Querystring: { leftRunId: string; rightRunId: string };
  }>(
    `${base}/compare`,
    {
      schema: {
        params: path,
        querystring: compareQuery,
        response: response(EvaluationComparisonSchema),
      },
    },
    async (request) => {
      const result = await evaluations.compareRuns(
        await helpers.actor(request),
        request.query.leftRunId,
        request.query.rightRunId,
      );
      if (
        !result ||
        result.left.definitionId !== request.params.definitionId ||
        result.right.definitionId !== request.params.definitionId
      )
        return helpers.notFound();
      return helpers.success(request, result);
    },
  );
}
