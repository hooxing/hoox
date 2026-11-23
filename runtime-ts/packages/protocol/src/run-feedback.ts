import { type Static, Type } from "@sinclair/typebox";
import { successEnvelopeSchema } from "./envelopes.js";
import { IdSchema, IsoTimestampSchema } from "./schemas.js";

export const MAX_RUN_FEEDBACK_COMMENT_LENGTH = 2000;
export const RunFeedbackRatingSchema = Type.Union([Type.Literal("up"), Type.Literal("down")]);
export const RunFeedbackCommentSchema = Type.String({
  maxLength: MAX_RUN_FEEDBACK_COMMENT_LENGTH,
  pattern: "^[^\\u0000]*$",
});
export const PutRunFeedbackRequestSchema = Type.Object(
  { rating: RunFeedbackRatingSchema, comment: Type.Optional(RunFeedbackCommentSchema) },
  { additionalProperties: false },
);
export type PutRunFeedbackRequest = Static<typeof PutRunFeedbackRequestSchema>;
export const RunFeedbackDtoSchema = Type.Object(
  {
    runId: IdSchema,
    revisionId: IdSchema,
    userId: IdSchema,
    rating: RunFeedbackRatingSchema,
    comment: Type.Optional(RunFeedbackCommentSchema),
    createdAt: IsoTimestampSchema,
    updatedAt: IsoTimestampSchema,
  },
  { additionalProperties: false },
);
export type RunFeedbackDto = Static<typeof RunFeedbackDtoSchema>;
export const RunFeedbackSuccessEnvelopeSchema = successEnvelopeSchema(
  Type.Object(
    { feedback: Type.Union([RunFeedbackDtoSchema, Type.Null()]) },
    { additionalProperties: false },
  ),
);
