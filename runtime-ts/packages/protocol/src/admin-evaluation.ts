import { type Static, Type } from "@sinclair/typebox";
import { IdSchema } from "./schemas.js";
import { AgentPinnedModelReferenceSchema } from "./agent-definition.js";

const strict = { additionalProperties: false } as const;

export const EvaluationAssertionSchema = Type.Union([
  Type.Object(
    {
      kind: Type.Literal("text_contains"),
      value: Type.String({ minLength: 1, maxLength: 2048 }),
      negate: Type.Optional(Type.Boolean()),
    },
    strict,
  ),
  Type.Object(
    {
      kind: Type.Literal("text_regex"),
      pattern: Type.String({ minLength: 1, maxLength: 256 }),
      negate: Type.Optional(Type.Boolean()),
    },
    strict,
  ),
  Type.Object(
    {
      kind: Type.Literal("tool_called"),
      toolName: Type.String({ minLength: 1, maxLength: 128 }),
      negate: Type.Optional(Type.Boolean()),
    },
    strict,
  ),
  Type.Object(
    {
      kind: Type.Literal("artifact_exists"),
      name: Type.Optional(Type.String({ maxLength: 200 })),
      type: Type.Optional(Type.String({ maxLength: 128 })),
    },
    strict,
  ),
  Type.Object(
    { kind: Type.Literal("model_score"), minimumScore: Type.Number({ minimum: 0, maximum: 1 }) },
    strict,
  ),
]);
export type EvaluationAssertion = Static<typeof EvaluationAssertionSchema>;

export const EvaluationCaseSchema = Type.Object(
  {
    id: IdSchema,
    name: Type.String({ minLength: 1, maxLength: 200 }),
    inputText: Type.String({ maxLength: 65536 }),
    attachments: Type.Array(
      Type.Union([
        Type.Object({ kind: Type.Literal("artifact"), artifactId: IdSchema }, strict),
        Type.Object(
          { kind: Type.Literal("resource"), resourceId: IdSchema, versionId: IdSchema },
          strict,
        ),
      ]),
      { maxItems: 32 },
    ),
    assertions: Type.Array(EvaluationAssertionSchema, { maxItems: 64 }),
  },
  strict,
);
export type EvaluationCase = Static<typeof EvaluationCaseSchema>;

export const EvaluationSuiteSchema = Type.Object(
  {
    id: IdSchema,
    definitionId: IdSchema,
    name: Type.String({ minLength: 1, maxLength: 200 }),
    description: Type.String({ maxLength: 4000 }),
    reviewerModel: Type.Optional(AgentPinnedModelReferenceSchema),
    reviewerRubric: Type.Optional(Type.String({ minLength: 1, maxLength: 8000 })),
    cases: Type.Array(EvaluationCaseSchema),
    contentAccess: Type.Optional(Type.Boolean()),
  },
  strict,
);
export type EvaluationSuite = Static<typeof EvaluationSuiteSchema>;

export const EvaluationRunRequestSchema = Type.Object(
  {
    id: IdSchema,
    revisionId: IdSchema,
    maxConcurrency: Type.Integer({ minimum: 1, maximum: 32 }),
  },
  strict,
);
export type EvaluationRunRequest = Static<typeof EvaluationRunRequestSchema>;

export const EvaluationRunStatusSchema = Type.Union([
  Type.Literal("queued"),
  Type.Literal("running"),
  Type.Literal("cancelled"),
  Type.Literal("completed"),
  Type.Literal("failed"),
]);
export const EvaluationRunSummarySchema = Type.Object(
  {
    id: IdSchema,
    definitionId: IdSchema,
    suiteId: IdSchema,
    revisionId: IdSchema,
    status: EvaluationRunStatusSchema,
    maxConcurrency: Type.Integer({ minimum: 1, maximum: 32 }),
    totalCases: Type.Integer({ minimum: 0 }),
    passRate: Type.Number({ minimum: 0, maximum: 1 }),
    passedCases: Type.Integer({ minimum: 0 }),
    failedCases: Type.Integer({ minimum: 0 }),
    unknownCases: Type.Integer({ minimum: 0 }),
    cancelledCases: Type.Integer({ minimum: 0 }),
    createdAt: Type.String({ format: "date-time" }),
  },
  strict,
);
export type EvaluationRunSummary = Static<typeof EvaluationRunSummarySchema>;

export const EvaluationCaseResultSchema = Type.Object(
  {
    caseId: IdSchema,
    caseName: Type.String({ maxLength: 200 }),
    outcome: Type.Union([
      Type.Literal("queued"),
      Type.Literal("running"),
      Type.Literal("passed"),
      Type.Literal("failed"),
      Type.Literal("unknown"),
      Type.Literal("cancelled"),
    ]),
    runId: Type.Optional(IdSchema),
    tenantId: Type.Optional(IdSchema),
    assertionResults: Type.Array(
      Type.Object({ passed: Type.Boolean(), reason: Type.String({ maxLength: 2000 }) }, strict),
    ),
    score: Type.Optional(Type.Number({ minimum: 0, maximum: 1 })),
    reason: Type.Optional(Type.String({ maxLength: 4000 })),
  },
  strict,
);
export type EvaluationCaseResult = Static<typeof EvaluationCaseResultSchema>;

export const EvaluationRunDetailSchema = Type.Object(
  {
    run: EvaluationRunSummarySchema,
    results: Type.Array(EvaluationCaseResultSchema),
  },
  strict,
);
export type EvaluationRunDetail = Static<typeof EvaluationRunDetailSchema>;

export const EvaluationComparisonSchema = Type.Object(
  {
    suiteId: IdSchema,
    left: EvaluationRunSummarySchema,
    right: EvaluationRunSummarySchema,
    leftPassRate: Type.Number({ minimum: 0, maximum: 1 }),
    rightPassRate: Type.Number({ minimum: 0, maximum: 1 }),
    cases: Type.Array(
      Type.Object(
        {
          caseId: IdSchema,
          caseName: Type.String({ maxLength: 200 }),
          leftOutcome: Type.Optional(Type.String()),
          rightOutcome: Type.Optional(Type.String()),
          changed: Type.Boolean(),
        },
        strict,
      ),
    ),
  },
  strict,
);
export type EvaluationComparison = Static<typeof EvaluationComparisonSchema>;
