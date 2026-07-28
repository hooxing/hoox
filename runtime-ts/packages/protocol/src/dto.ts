import { type Static, Type } from "@sinclair/typebox";
import { IdSchema, IsoTimestampSchema, RunStatusSchema, Sha256DigestSchema } from "./schemas.js";

const strict = { additionalProperties: false } as const;

export const UserDtoSchema = Type.Object(
  { id: IdSchema, createdAt: IsoTimestampSchema },
  { ...strict, $id: "v1.UserDto" },
);
export type UserDto = Static<typeof UserDtoSchema>;

export const TenantDtoSchema = Type.Union(
  [
    Type.Object(
      {
        id: IdSchema,
        kind: Type.Literal("personal"),
        ownerUserId: IdSchema,
        createdAt: IsoTimestampSchema,
      },
      strict,
    ),
    Type.Object(
      {
        id: IdSchema,
        kind: Type.Literal("team"),
        displayName: Type.String({ minLength: 1, maxLength: 200 }),
        createdByUserId: IdSchema,
        createdAt: IsoTimestampSchema,
      },
      strict,
    ),
  ],
  { $id: "v1.TenantDto" },
);
export type TenantDto = Static<typeof TenantDtoSchema>;

export const MembershipDtoSchema = Type.Object(
  {
    id: IdSchema,
    tenantId: IdSchema,
    userId: IdSchema,
    role: Type.Union([Type.Literal("owner"), Type.Literal("admin"), Type.Literal("member")]),
    status: Type.Union([Type.Literal("active"), Type.Literal("revoked")]),
    createdAt: IsoTimestampSchema,
  },
  { ...strict, $id: "v1.MembershipDto" },
);
export type MembershipDto = Static<typeof MembershipDtoSchema>;

export const ThreadDtoSchema = Type.Object(
  {
    id: IdSchema,
    tenantId: IdSchema,
    createdByUserId: IdSchema,
    title: Type.String({ minLength: 1, maxLength: 200 }),
    status: Type.Union([Type.Literal("active"), Type.Literal("archived")]),
    createdAt: IsoTimestampSchema,
    updatedAt: IsoTimestampSchema,
  },
  { ...strict, $id: "v1.ThreadDto" },
);
export type ThreadDto = Static<typeof ThreadDtoSchema>;

export const RunDtoSchema = Type.Object(
  {
    id: IdSchema,
    tenantId: IdSchema,
    threadId: IdSchema,
    status: RunStatusSchema,
    createdAt: IsoTimestampSchema,
    updatedAt: IsoTimestampSchema,
  },
  { ...strict, $id: "v1.RunDto" },
);
export type RunDto = Static<typeof RunDtoSchema>;

export const WorkspaceRevisionDtoSchema = Type.Object(
  {
    id: IdSchema,
    workspaceId: IdSchema,
    tenantId: IdSchema,
    threadId: IdSchema,
    revisionNumber: Type.Integer({ minimum: 1 }),
    parentRevisionId: Type.Optional(IdSchema),
    createdByRunId: IdSchema,
    leaseEpoch: Type.Integer({ minimum: 1 }),
    objectKey: Type.String({ minLength: 1 }),
    digest: Sha256DigestSchema,
    createdAt: IsoTimestampSchema,
  },
  { ...strict, $id: "v1.WorkspaceRevisionDto" },
);
export type WorkspaceRevisionDto = Static<typeof WorkspaceRevisionDtoSchema>;

export const ResourceVersionDtoSchema = Type.Object(
  {
    id: IdSchema,
    resourceId: IdSchema,
    tenantId: IdSchema,
    versionNumber: Type.Integer({ minimum: 1 }),
    parentVersionId: Type.Optional(IdSchema),
    objectKey: Type.String({ minLength: 1 }),
    digest: Sha256DigestSchema,
    mediaType: Type.String({ minLength: 1 }),
    sizeBytes: Type.Integer({ minimum: 0 }),
    createdAt: IsoTimestampSchema,
  },
  { ...strict, $id: "v1.ResourceVersionDto" },
);
export type ResourceVersionDto = Static<typeof ResourceVersionDtoSchema>;

export const ArtifactDtoSchema = Type.Object(
  {
    id: IdSchema,
    tenantId: IdSchema,
    threadId: IdSchema,
    runId: IdSchema,
    resourceVersionId: IdSchema,
    replacesArtifactId: Type.Optional(IdSchema),
    name: Type.String({ minLength: 1, maxLength: 255 }),
    mediaType: Type.Optional(Type.String({ minLength: 1, maxLength: 255 })),
    sizeBytes: Type.Optional(Type.Integer({ minimum: 0 })),
    status: Type.Union([
      Type.Literal("publishing"),
      Type.Literal("published"),
      Type.Literal("failed"),
    ]),
    createdAt: IsoTimestampSchema,
    updatedAt: IsoTimestampSchema,
  },
  { ...strict, $id: "v1.ArtifactDto" },
);
export type ArtifactDto = Static<typeof ArtifactDtoSchema>;
