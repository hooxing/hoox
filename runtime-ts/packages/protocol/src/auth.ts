import { type Static, Type } from "@sinclair/typebox";
import { successEnvelopeSchema } from "./envelopes.js";
import { IdSchema, IsoTimestampSchema } from "./schemas.js";

const strict = { additionalProperties: false } as const;

export const AccountProfileDtoSchema = Type.Object(
  {
    id: IdSchema,
    displayName: Type.String({ minLength: 2, maxLength: 32 }),
    email: Type.String({ minLength: 3, maxLength: 254 }),
  },
  { ...strict, $id: "v1.AccountProfileDto" },
);
export type AccountProfileDto = Static<typeof AccountProfileDtoSchema>;

export const RegisterAccountRequestSchema = Type.Object(
  {
    displayName: Type.String({ minLength: 2, maxLength: 32 }),
    email: Type.String({ minLength: 3, maxLength: 254 }),
    password: Type.String({ minLength: 8, maxLength: 128 }),
  },
  strict,
);
export type RegisterAccountRequest = Static<typeof RegisterAccountRequestSchema>;

export const LoginAccountRequestSchema = Type.Object(
  {
    email: Type.String({ minLength: 3, maxLength: 254 }),
    password: Type.String({ minLength: 8, maxLength: 128 }),
  },
  strict,
);
export type LoginAccountRequest = Static<typeof LoginAccountRequestSchema>;

export const AccountSessionDtoSchema = Type.Object(
  {
    profile: AccountProfileDtoSchema,
    accessToken: Type.String({ minLength: 32, maxLength: 256 }),
    expiresAt: IsoTimestampSchema,
  },
  { ...strict, $id: "v1.AccountSessionDto" },
);
export type AccountSessionDto = Static<typeof AccountSessionDtoSchema>;

export const AccountSessionSuccessEnvelopeSchema = successEnvelopeSchema(AccountSessionDtoSchema);
export const AccountProfileSuccessEnvelopeSchema = successEnvelopeSchema(AccountProfileDtoSchema);
export const LogoutAccountSuccessEnvelopeSchema = successEnvelopeSchema(
  Type.Object({ loggedOut: Type.Literal(true) }, strict),
);
