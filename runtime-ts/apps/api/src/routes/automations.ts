import { createHash } from "node:crypto";
import type { ScheduledTaskManagementPort, ScheduledTaskMutation } from "@hoox/automation";
import {
  type CreateScheduledTaskRequest,
  CreateScheduledTaskRequestSchema,
  ErrorEnvelopeSchema,
  ScheduledTaskListSuccessEnvelopeSchema,
  type ScheduledTaskPath,
  ScheduledTaskPathSchema,
  ScheduledTaskSuccessEnvelopeSchema,
  type UpdateScheduledTaskRequest,
  UpdateScheduledTaskRequestSchema,
} from "@hoox/protocol";
import type { FastifyInstance, FastifyRequest } from "fastify";
import { requireIdempotencyKey, requireJsonContentType, success } from "../http.js";
import type { AuthenticateRequest } from "../request-auth.js";
import { ApiFailure } from "../service.js";

export function registerAutomationRoutes(
  app: FastifyInstance,
  scheduledTasks: ScheduledTaskManagementPort | undefined,
  authenticate: AuthenticateRequest,
): void {
  if (scheduledTasks !== undefined) {
    const mutateScheduledTask = async (
      request: FastifyRequest,
      mutation: ScheduledTaskMutation,
    ) => {
      const auth = await authenticate(request);
      const result = await scheduledTasks.mutate({
        scope: auth.scope,
        commandId: requireIdempotencyKey(request),
        requestDigest: createHash("sha256").update(JSON.stringify(mutation)).digest("hex"),
        mutation,
      });
      if (result.outcome === "applied" || result.outcome === "replayed") return result.task;
      if (result.outcome === "key_conflict") throw new ApiFailure("conflict");
      if (result.outcome === "not_found" || result.outcome === "not_authorized") {
        throw new ApiFailure("not_found");
      }
      throw new ApiFailure("invalid_state");
    };

    app.get(
      "/v1/automations",
      {
        schema: {
          response: {
            200: ScheduledTaskListSuccessEnvelopeSchema,
            401: ErrorEnvelopeSchema,
            500: ErrorEnvelopeSchema,
            503: ErrorEnvelopeSchema,
          },
        },
      },
      async (request) => {
        const auth = await authenticate(request);
        return success(request, { items: await scheduledTasks.list({ scope: auth.scope }) });
      },
    );

    app.post<{ Body: CreateScheduledTaskRequest }>(
      "/v1/automations",
      {
        preValidation: async (request) => requireJsonContentType(request),
        schema: {
          body: CreateScheduledTaskRequestSchema,
          response: {
            200: ScheduledTaskSuccessEnvelopeSchema,
            400: ErrorEnvelopeSchema,
            401: ErrorEnvelopeSchema,
            404: ErrorEnvelopeSchema,
            409: ErrorEnvelopeSchema,
            415: ErrorEnvelopeSchema,
            500: ErrorEnvelopeSchema,
            503: ErrorEnvelopeSchema,
          },
        },
      },
      async (request) =>
        success(
          request,
          await mutateScheduledTask(request, {
            action: "create",
            sourceThreadId: request.body.targetThreadId,
            targetThreadId: request.body.targetThreadId,
            name: request.body.name,
            instruction: request.body.instruction,
            firstRunAt: request.body.firstRunAt,
            ...(request.body.rrule === undefined ? {} : { rrule: request.body.rrule }),
            timezone: request.body.timezone,
            ...(request.body.overlapPolicy === undefined
              ? {}
              : { overlapPolicy: request.body.overlapPolicy }),
          }),
        ),
    );

    app.patch<{ Params: ScheduledTaskPath; Body: UpdateScheduledTaskRequest }>(
      "/v1/automations/:taskId",
      {
        preValidation: async (request) => requireJsonContentType(request),
        schema: {
          params: ScheduledTaskPathSchema,
          body: UpdateScheduledTaskRequestSchema,
          response: {
            200: ScheduledTaskSuccessEnvelopeSchema,
            400: ErrorEnvelopeSchema,
            401: ErrorEnvelopeSchema,
            404: ErrorEnvelopeSchema,
            409: ErrorEnvelopeSchema,
            415: ErrorEnvelopeSchema,
            500: ErrorEnvelopeSchema,
            503: ErrorEnvelopeSchema,
          },
        },
      },
      async (request) => {
        const mutation: ScheduledTaskMutation =
          request.body.action === "update"
            ? {
                action: "update",
                taskId: request.params.taskId,
                ...(request.body.name === undefined ? {} : { name: request.body.name }),
                ...(request.body.instruction === undefined
                  ? {}
                  : { instruction: request.body.instruction }),
                ...(request.body.firstRunAt === undefined
                  ? {}
                  : { firstRunAt: request.body.firstRunAt }),
                ...(request.body.rrule === undefined ? {} : { rrule: request.body.rrule }),
                ...(request.body.timezone === undefined ? {} : { timezone: request.body.timezone }),
                ...(request.body.overlapPolicy === undefined
                  ? {}
                  : { overlapPolicy: request.body.overlapPolicy }),
              }
            : { action: request.body.action, taskId: request.params.taskId };
        return success(request, await mutateScheduledTask(request, mutation));
      },
    );
  }
}
