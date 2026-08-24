import { createCipheriv, createDecipheriv, createHash, hkdfSync, randomBytes } from "node:crypto";
import { betterAuth, type BetterAuthOptions, type BetterAuthPlugin } from "better-auth";
import { genericOAuth, phoneNumber } from "better-auth/plugins";
import type { OAuth2Tokens } from "better-auth/oauth2";
import type { Pool } from "pg";

export const identityProviderKeys = ["google", "github", "wechat", "qq"] as const;
export type IdentityProviderKey = (typeof identityProviderKeys)[number];

export interface IdentityProviderConfiguration {
  readonly enabled: boolean;
  readonly clientId: string;
  readonly clientSecret?: string;
  readonly secretConfigured: boolean;
}

export interface IdentityConfiguration {
  readonly versionToken: number;
  readonly emailPasswordEnabled: boolean;
  readonly registrationEnabled: boolean;
  readonly phoneEnabled: boolean;
  readonly smsWebhookUrl?: string;
  readonly smsWebhookSecretConfigured: boolean;
  readonly providers: Readonly<Record<IdentityProviderKey, IdentityProviderConfiguration>>;
  readonly updatedAt?: string;
  readonly updatedBy?: string;
}

export interface IdentityConfigurationSecrets {
  readonly providerSecrets: Partial<Record<IdentityProviderKey, string>>;
  readonly smsWebhookSecret?: string;
}

export interface EditableIdentityConfiguration {
  readonly expectedVersionToken: number;
  readonly emailPasswordEnabled: boolean;
  readonly registrationEnabled: boolean;
  readonly phoneEnabled: boolean;
  readonly smsWebhookUrl?: string;
  readonly smsWebhookSecret?: string;
  readonly providers: Readonly<
    Record<
      IdentityProviderKey,
      Readonly<{
        readonly enabled: boolean;
        readonly clientId: string;
        readonly clientSecret?: string;
      }>
    >
  >;
}

export interface EncryptedIdentitySecrets {
  readonly ciphertext: Uint8Array;
  readonly nonce: Uint8Array;
  readonly tag: Uint8Array;
}

const emailPattern = /^[^\s@]+@[^\s@]+\.[^\s@]+$/u;
const phonePattern = /^\+[1-9][0-9]{7,14}$/u;
const encryptionSalt = Buffer.from("hoox-identity-config-v1", "utf8");
const encryptionInfo = Buffer.from("provider-secrets", "utf8");

export function emptyIdentityConfiguration(): IdentityConfiguration {
  return Object.freeze({
    versionToken: 0,
    emailPasswordEnabled: true,
    registrationEnabled: true,
    phoneEnabled: false,
    smsWebhookSecretConfigured: false,
    providers: Object.freeze({
      google: Object.freeze({ enabled: false, clientId: "", secretConfigured: false }),
      github: Object.freeze({ enabled: false, clientId: "", secretConfigured: false }),
      wechat: Object.freeze({ enabled: false, clientId: "", secretConfigured: false }),
      qq: Object.freeze({ enabled: false, clientId: "", secretConfigured: false }),
    }),
  });
}

function normalizedText(value: string | undefined, maximum: number): string | undefined {
  const normalized = value?.trim();
  if (normalized === undefined || normalized === "") return undefined;
  if (Buffer.byteLength(normalized, "utf8") > maximum) throw new TypeError("IDENTITY_TEXT_INVALID");
  return normalized;
}

function normalizeWebhookUrl(value: string | undefined): string | undefined {
  const normalized = normalizedText(value, 2_048);
  if (normalized === undefined) return undefined;
  const url = new URL(normalized);
  if (
    url.protocol !== "https:" ||
    url.username !== "" ||
    url.password !== "" ||
    url.hash !== "" ||
    url.hostname === "localhost" ||
    url.hostname.endsWith(".localhost") ||
    /^(?:127\.|10\.|192\.168\.|169\.254\.|0\.|\[?::1\]?$)/u.test(url.hostname)
  ) {
    throw new TypeError("IDENTITY_SMS_WEBHOOK_URL_INVALID");
  }
  return url.href;
}

export function normalizeEditableIdentityConfiguration(
  input: EditableIdentityConfiguration,
  currentSecrets: IdentityConfigurationSecrets,
): Readonly<{
  configuration: Omit<IdentityConfiguration, "updatedAt" | "updatedBy">;
  secrets: IdentityConfigurationSecrets;
}> {
  if (!Number.isSafeInteger(input.expectedVersionToken) || input.expectedVersionToken < 0) {
    throw new TypeError("IDENTITY_VERSION_INVALID");
  }
  const providerSecrets = { ...currentSecrets.providerSecrets };
  const providers = Object.fromEntries(
    identityProviderKeys.map((key) => {
      const candidate = input.providers[key];
      const clientId = normalizedText(candidate.clientId, 512) ?? "";
      const replacementSecret = normalizedText(candidate.clientSecret, 4_096);
      if (replacementSecret !== undefined) providerSecrets[key] = replacementSecret;
      const secretConfigured = normalizedText(providerSecrets[key], 4_096) !== undefined;
      if (candidate.enabled && (clientId === "" || !secretConfigured)) {
        throw new TypeError(`IDENTITY_PROVIDER_INCOMPLETE:${key}`);
      }
      return [key, Object.freeze({ enabled: candidate.enabled, clientId, secretConfigured })];
    }),
  ) as unknown as Record<IdentityProviderKey, IdentityProviderConfiguration>;
  const smsWebhookUrl = normalizeWebhookUrl(input.smsWebhookUrl);
  const replacementSmsSecret = normalizedText(input.smsWebhookSecret, 4_096);
  const smsWebhookSecret = replacementSmsSecret ?? currentSecrets.smsWebhookSecret;
  if (input.phoneEnabled && smsWebhookUrl === undefined) {
    throw new TypeError("IDENTITY_SMS_WEBHOOK_REQUIRED");
  }
  return Object.freeze({
    configuration: Object.freeze({
      versionToken: input.expectedVersionToken + 1,
      emailPasswordEnabled: input.emailPasswordEnabled,
      registrationEnabled: input.registrationEnabled,
      phoneEnabled: input.phoneEnabled,
      ...(smsWebhookUrl === undefined ? {} : { smsWebhookUrl }),
      smsWebhookSecretConfigured: smsWebhookSecret !== undefined,
      providers: Object.freeze(providers),
    }),
    secrets: Object.freeze({
      providerSecrets: Object.freeze(providerSecrets),
      ...(smsWebhookSecret === undefined ? {} : { smsWebhookSecret }),
    }),
  });
}

function encryptionKey(secret: string): Buffer {
  if (Buffer.byteLength(secret, "utf8") < 32) throw new TypeError("BETTER_AUTH_SECRET_TOO_SHORT");
  return Buffer.from(
    hkdfSync("sha256", Buffer.from(secret, "utf8"), encryptionSalt, encryptionInfo, 32),
  );
}

export function encryptIdentitySecrets(
  secret: string,
  secrets: IdentityConfigurationSecrets,
): EncryptedIdentitySecrets {
  const nonce = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", encryptionKey(secret), nonce);
  cipher.setAAD(encryptionSalt);
  const plaintext = Buffer.from(JSON.stringify(secrets), "utf8");
  const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  return Object.freeze({ ciphertext, nonce, tag: cipher.getAuthTag() });
}

export function decryptIdentitySecrets(
  secret: string,
  encrypted: EncryptedIdentitySecrets | undefined,
): IdentityConfigurationSecrets {
  if (encrypted === undefined) return Object.freeze({ providerSecrets: Object.freeze({}) });
  const decipher = createDecipheriv("aes-256-gcm", encryptionKey(secret), encrypted.nonce);
  decipher.setAAD(encryptionSalt);
  decipher.setAuthTag(Buffer.from(encrypted.tag));
  const plaintext = Buffer.concat([
    decipher.update(Buffer.from(encrypted.ciphertext)),
    decipher.final(),
  ]).toString("utf8");
  const parsed = JSON.parse(plaintext) as {
    readonly providerSecrets?: Partial<Record<IdentityProviderKey, unknown>>;
    readonly smsWebhookSecret?: unknown;
  };
  const providerSecrets: Partial<Record<IdentityProviderKey, string>> = {};
  for (const key of identityProviderKeys) {
    const value = parsed.providerSecrets?.[key];
    if (typeof value === "string" && value.length > 0) providerSecrets[key] = value;
  }
  return Object.freeze({
    providerSecrets: Object.freeze(providerSecrets),
    ...(typeof parsed.smsWebhookSecret === "string" && parsed.smsWebhookSecret.length > 0
      ? { smsWebhookSecret: parsed.smsWebhookSecret }
      : {}),
  });
}

function requireSecret(
  configuration: IdentityConfiguration,
  secrets: IdentityConfigurationSecrets,
  key: IdentityProviderKey,
): string | undefined {
  if (!configuration.providers[key].enabled) return undefined;
  const value = secrets.providerSecrets[key];
  if (value === undefined) throw new TypeError(`IDENTITY_PROVIDER_SECRET_MISSING:${key}`);
  return value;
}

function parseQqPayload(raw: string): Record<string, unknown> {
  const trimmed = raw.trim();
  if (trimmed.startsWith("callback")) {
    const start = trimmed.indexOf("{");
    const end = trimmed.lastIndexOf("}");
    if (start < 0 || end <= start) throw new Error("QQ_OAUTH_RESPONSE_INVALID");
    return JSON.parse(trimmed.slice(start, end + 1)) as Record<string, unknown>;
  }
  return Object.fromEntries(new URLSearchParams(trimmed).entries());
}

async function qqToken(input: {
  readonly clientId: string;
  readonly clientSecret: string;
  readonly code: string;
  readonly redirectURI: string;
}): Promise<OAuth2Tokens> {
  const response = await fetch("https://graph.qq.com/oauth2.0/token", {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded", accept: "text/plain" },
    body: new URLSearchParams({
      grant_type: "authorization_code",
      client_id: input.clientId,
      client_secret: input.clientSecret,
      code: input.code,
      redirect_uri: input.redirectURI,
      fmt: "json",
    }),
    signal: AbortSignal.timeout(15_000),
  });
  if (!response.ok) throw new Error("QQ_OAUTH_TOKEN_FAILED");
  const payload = parseQqPayload(await response.text());
  const accessToken = payload.access_token;
  if (typeof accessToken !== "string" || accessToken.length === 0) {
    throw new Error("QQ_OAUTH_TOKEN_INVALID");
  }
  const expiresIn = Number(payload.expires_in);
  return {
    accessToken,
    tokenType: "Bearer",
    ...(typeof payload.refresh_token === "string" ? { refreshToken: payload.refresh_token } : {}),
    ...(Number.isFinite(expiresIn) && expiresIn > 0
      ? { accessTokenExpiresAt: new Date(Date.now() + expiresIn * 1_000) }
      : {}),
  };
}

async function qqUserInfo(clientId: string, tokens: OAuth2Tokens) {
  if (tokens.accessToken === undefined) return null;
  const openIdResponse = await fetch(
    `https://graph.qq.com/oauth2.0/me?${new URLSearchParams({ access_token: tokens.accessToken, fmt: "json" })}`,
    { headers: { accept: "application/json,text/plain" }, signal: AbortSignal.timeout(15_000) },
  );
  if (!openIdResponse.ok) return null;
  const identity = parseQqPayload(await openIdResponse.text());
  const openid = identity.openid;
  if (typeof openid !== "string" || openid.length === 0) return null;
  const profileResponse = await fetch(
    `https://graph.qq.com/user/get_user_info?${new URLSearchParams({ access_token: tokens.accessToken, oauth_consumer_key: clientId, openid, fmt: "json" })}`,
    { headers: { accept: "application/json" }, signal: AbortSignal.timeout(15_000) },
  );
  if (!profileResponse.ok) return null;
  const profile = (await profileResponse.json()) as Record<string, unknown>;
  if (Number(profile.ret) !== 0) return null;
  const image =
    typeof profile.figureurl_qq_2 === "string"
      ? profile.figureurl_qq_2
      : typeof profile.figureurl_qq_1 === "string"
        ? profile.figureurl_qq_1
        : undefined;
  return {
    id: openid,
    name: typeof profile.nickname === "string" ? profile.nickname : "QQ 用户",
    email: `${openid}@qq.invalid`,
    emailVerified: false,
    ...(image === undefined ? {} : { image }),
  };
}

async function sendSmsWebhook(input: {
  readonly url: string;
  readonly secret?: string;
  readonly phoneNumber: string;
  readonly code: string;
}): Promise<void> {
  if (!phonePattern.test(input.phoneNumber)) throw new TypeError("PHONE_NUMBER_INVALID");
  const response = await fetch(input.url, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...(input.secret === undefined ? {} : { authorization: `Bearer ${input.secret}` }),
    },
    body: JSON.stringify({ phoneNumber: input.phoneNumber, code: input.code, purpose: "login" }),
    signal: AbortSignal.timeout(15_000),
    redirect: "error",
  });
  if (!response.ok) throw new Error("SMS_WEBHOOK_FAILED");
}

export function createEmbeddedBetterAuth(input: {
  readonly database: Pool;
  readonly baseURL: string;
  readonly secret: string;
  readonly configuration: IdentityConfiguration;
  readonly secrets: IdentityConfigurationSecrets;
  readonly trustedOrigins?: readonly string[];
}) {
  const { configuration, secrets } = input;
  const googleSecret = requireSecret(configuration, secrets, "google");
  const githubSecret = requireSecret(configuration, secrets, "github");
  const wechatSecret = requireSecret(configuration, secrets, "wechat");
  const qqSecret = requireSecret(configuration, secrets, "qq");
  const socialProviders: NonNullable<BetterAuthOptions["socialProviders"]> = {};
  if (googleSecret !== undefined) {
    socialProviders.google = {
      clientId: configuration.providers.google.clientId,
      clientSecret: googleSecret,
    };
  }
  if (githubSecret !== undefined) {
    socialProviders.github = {
      clientId: configuration.providers.github.clientId,
      clientSecret: githubSecret,
    };
  }
  if (wechatSecret !== undefined) {
    socialProviders.wechat = {
      clientId: configuration.providers.wechat.clientId,
      clientSecret: wechatSecret,
      platformType: "WebsiteApp",
      lang: "cn",
    };
  }
  const plugins: BetterAuthPlugin[] = [];
  if (qqSecret !== undefined) {
    const clientId = configuration.providers.qq.clientId;
    plugins.push(
      genericOAuth({
        config: [
          {
            providerId: "qq",
            name: "QQ",
            clientId,
            clientSecret: qqSecret,
            authorizationUrl: "https://graph.qq.com/oauth2.0/authorize",
            tokenUrl: "https://graph.qq.com/oauth2.0/token",
            scopes: ["get_user_info"],
            pkce: false,
            getToken: ({ code, redirectURI }) =>
              qqToken({ clientId, clientSecret: qqSecret, code, redirectURI }),
            getUserInfo: (tokens) => qqUserInfo(clientId, tokens),
            mapProfileToUser: (profile) => ({
              name: typeof profile.name === "string" ? profile.name : "QQ 用户",
              email:
                typeof profile.email === "string" && emailPattern.test(profile.email)
                  ? profile.email
                  : `${String(profile.id)}@qq.invalid`,
              emailVerified: false,
              ...(typeof profile.image === "string" ? { image: profile.image } : {}),
            }),
          },
        ],
      }),
    );
  }
  if (configuration.phoneEnabled && configuration.smsWebhookUrl !== undefined) {
    plugins.push(
      phoneNumber({
        requireVerification: true,
        phoneNumberValidator: (value) => phonePattern.test(value),
        sendOTP: ({ phoneNumber: number, code }) =>
          sendSmsWebhook({
            url: configuration.smsWebhookUrl as string,
            ...(secrets.smsWebhookSecret === undefined ? {} : { secret: secrets.smsWebhookSecret }),
            phoneNumber: number,
            code,
          }),
        signUpOnVerification: {
          getTempEmail: (number) =>
            `${createHash("sha256").update(number).digest("hex")}@phone.invalid`,
          getTempName: (number) => `手机用户 ${number.slice(-4)}`,
        },
      }),
    );
  }
  return betterAuth({
    appName: "Hoox",
    baseURL: input.baseURL,
    basePath: "/api/auth",
    secret: input.secret,
    database: input.database,
    trustedOrigins: [...(input.trustedOrigins ?? [])],
    emailAndPassword: {
      enabled: configuration.emailPasswordEnabled,
      disableSignUp: !configuration.registrationEnabled,
      minPasswordLength: 8,
      maxPasswordLength: 128,
    },
    socialProviders,
    plugins,
    account: {
      modelName: "better_auth_accounts",
      encryptOAuthTokens: true,
      fields: {
        accountId: "account_id",
        providerId: "provider_id",
        userId: "user_id",
        accessToken: "access_token",
        refreshToken: "refresh_token",
        idToken: "id_token",
        accessTokenExpiresAt: "access_token_expires_at",
        refreshTokenExpiresAt: "refresh_token_expires_at",
        createdAt: "created_at",
        updatedAt: "updated_at",
      },
    },
    user: {
      modelName: "better_auth_users",
      fields: {
        emailVerified: "email_verified",
        createdAt: "created_at",
        updatedAt: "updated_at",
      },
    },
    session: {
      modelName: "better_auth_sessions",
      fields: {
        expiresAt: "expires_at",
        createdAt: "created_at",
        updatedAt: "updated_at",
        ipAddress: "ip_address",
        userAgent: "user_agent",
        userId: "user_id",
      },
    },
    verification: {
      modelName: "better_auth_verifications",
      storeIdentifier: "hashed",
      fields: { expiresAt: "expires_at", createdAt: "created_at", updatedAt: "updated_at" },
    },
    advanced: { database: { generateId: "uuid" } },
    rateLimit: { enabled: true, storage: "database", window: 60, max: 100 },
  });
}

export type EmbeddedBetterAuth = ReturnType<typeof createEmbeddedBetterAuth>;
