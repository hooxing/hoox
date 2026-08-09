import { type Static, Type } from "@sinclair/typebox";
import { ThreadDtoSchema } from "./dto.js";
import { successEnvelopeSchema } from "./envelopes.js";
import { IdSchema, IsoTimestampSchema } from "./schemas.js";

const strict = { additionalProperties: false } as const;
const TeamRoleSchema = Type.Union([
  Type.Literal("owner"),
  Type.Literal("admin"),
  Type.Literal("member"),
]);

export const TeamSummaryDtoSchema = Type.Object(
  {
    id: IdSchema,
    displayName: Type.String({ minLength: 1, maxLength: 200 }),
    role: TeamRoleSchema,
    joinedAt: IsoTimestampSchema,
  },
  { ...strict, $id: "v1.TeamSummaryDto" },
);
export type TeamSummaryDto = Static<typeof TeamSummaryDtoSchema>;

export const TeamMemberDtoSchema = Type.Object(
  {
    membershipId: IdSchema,
    userId: IdSchema,
    role: TeamRoleSchema,
    joinedAt: IsoTimestampSchema,
  },
  { ...strict, $id: "v1.TeamMemberDto" },
);
export type TeamMemberDto = Static<typeof TeamMemberDtoSchema>;

export const CreateTeamRequestSchema = Type.Object(
  { displayName: Type.String({ minLength: 1, maxLength: 200 }) },
  strict,
);
export type CreateTeamRequest = Static<typeof CreateTeamRequestSchema>;

export const TeamPathSchema = Type.Object({ teamId: IdSchema }, strict);
export type TeamPath = Static<typeof TeamPathSchema>;

export const TeamMemberPathSchema = Type.Object({ teamId: IdSchema, userId: IdSchema }, strict);
export type TeamMemberPath = Static<typeof TeamMemberPathSchema>;

export const AddTeamMemberRequestSchema = Type.Object(
  { userId: IdSchema, role: Type.Union([Type.Literal("admin"), Type.Literal("member")]) },
  strict,
);
export type AddTeamMemberRequest = Static<typeof AddTeamMemberRequestSchema>;

export const ChangeTeamMemberRoleRequestSchema = Type.Object({ role: TeamRoleSchema }, strict);
export type ChangeTeamMemberRoleRequest = Static<typeof ChangeTeamMemberRoleRequestSchema>;

export const ForkThreadRequestSchema = Type.Object(
  {
    title: Type.Optional(Type.String({ minLength: 1, maxLength: 200 })),
    targetTeamId: Type.Optional(IdSchema),
  },
  strict,
);
export type ForkThreadRequest = Static<typeof ForkThreadRequestSchema>;

export const ImportTeamFileRequestSchema = Type.Object(
  { sourceTeamId: IdSchema, resourceId: IdSchema, versionId: IdSchema },
  strict,
);
export type ImportTeamFileRequest = Static<typeof ImportTeamFileRequestSchema>;

export const TeamListSuccessEnvelopeSchema = successEnvelopeSchema(
  Type.Object({ items: Type.Array(TeamSummaryDtoSchema, { maxItems: 100 }) }, strict),
);
export const TeamMemberListSuccessEnvelopeSchema = successEnvelopeSchema(
  Type.Object({ items: Type.Array(TeamMemberDtoSchema, { maxItems: 500 }) }, strict),
);
export const TeamSuccessEnvelopeSchema = successEnvelopeSchema(TeamSummaryDtoSchema);
export const TeamMembershipSuccessEnvelopeSchema = successEnvelopeSchema(TeamMemberDtoSchema);
export const TeamDissolveSuccessEnvelopeSchema = successEnvelopeSchema(
  Type.Object({ dissolved: Type.Literal(true) }, strict),
);
export const TeamMemberRemovalSuccessEnvelopeSchema = successEnvelopeSchema(
  Type.Object({ removed: Type.Literal(true) }, strict),
);
export const ThreadForkSuccessEnvelopeSchema = successEnvelopeSchema(ThreadDtoSchema);
