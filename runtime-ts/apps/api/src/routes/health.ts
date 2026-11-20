import { ErrorEnvelopeSchema, HealthSuccessEnvelopeSchema } from "@hoox/protocol";
import type { FastifyInstance } from "fastify";
import type { ApiDependencies } from "../dependencies.js";
import { success } from "../http.js";
import { ApiFailure } from "../service.js";

export function registerHealthRoutes(
  app: FastifyInstance,
  dependencies: Pick<ApiDependencies, "clock" | "readiness">,
): void {
  const healthSchema = {
    response: { 200: HealthSuccessEnvelopeSchema, 503: ErrorEnvelopeSchema },
  } as const;
  app.get("/live", { schema: healthSchema }, async (request) =>
    success(request, { status: "ok" as const, checkedAt: dependencies.clock.now() }),
  );
  app.get("/ready", { schema: healthSchema }, async (request) => {
    try {
      await dependencies.readiness.probe();
    } catch {
      throw new ApiFailure("dependency_unavailable");
    }
    return success(request, {
      status: "ok" as const,
      checkedAt: dependencies.clock.now(),
    });
  });
}
