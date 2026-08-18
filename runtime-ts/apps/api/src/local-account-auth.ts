import { createHash, randomBytes, randomUUID, scrypt, timingSafeEqual } from "node:crypto";
import { tenantId, userId } from "@hoox/domain";
import type { LocalAccountRepository } from "@hoox/persistence";
import type {
  AccountProfileDto,
  AccountSessionDto,
  LoginAccountRequest,
  RegisterAccountRequest,
} from "@hoox/protocol";
import type { ApiClock, AuthContextResolver, AuthPrincipal } from "./ports.js";
import { ApiFailure } from "./service.js";

const sessionTokenPrefix = "hoox_session_";
const passwordAlgorithm = "scrypt-v1" as const;
const passwordKeyLength = 32;
const passwordSaltLength = 16;
const sessionLifetimeMilliseconds = 30 * 24 * 60 * 60_000;
const emailPattern = /^[^\s@]+@[^\s@]+\.[^\s@]+$/u;
const dummySalt = Buffer.alloc(passwordSaltLength, 0x5a);
const dummyHash = Buffer.alloc(passwordKeyLength, 0xa5);

function normalizeEmail(raw: string): string {
  const value = raw.trim().toLocaleLowerCase("en-US");
  if (
    value.length < 3 ||
    value.length > 254 ||
    Buffer.byteLength(value, "utf8") > 254 ||
    !emailPattern.test(value)
  ) {
    throw new ApiFailure("bad_request");
  }
  return value;
}

function normalizeDisplayName(raw: string): string {
  const value = raw.trim();
  const length = Array.from(value).length;
  if (length < 2 || length > 32 || Buffer.byteLength(value, "utf8") > 128) {
    throw new ApiFailure("bad_request");
  }
  return value;
}

function validatePassword(password: string): void {
  const length = Array.from(password).length;
  if (length < 8 || length > 128 || Buffer.byteLength(password, "utf8") > 512) {
    throw new ApiFailure("bad_request");
  }
}

function derivePassword(password: string, salt: Uint8Array): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    scrypt(
      password,
      Buffer.from(salt),
      passwordKeyLength,
      { N: 16_384, r: 8, p: 1, maxmem: 64 * 1_024 * 1_024 },
      (error, key) => {
        if (error !== null) reject(error);
        else resolve(key);
      },
    );
  });
}

function tokenDigest(token: string): string {
  return createHash("sha256").update(token, "utf8").digest("hex");
}

function parseSessionToken(authorization: string | undefined): string | undefined {
  if (authorization === undefined || !authorization.startsWith("Bearer ")) return undefined;
  const token = authorization.slice("Bearer ".length);
  if (
    token.length < sessionTokenPrefix.length + 32 ||
    token.length > 256 ||
    !token.startsWith(sessionTokenPrefix) ||
    !/^[-_A-Za-z0-9]+$/u.test(token)
  ) {
    return undefined;
  }
  return token;
}

function createSessionToken(): string {
  return `${sessionTokenPrefix}${randomBytes(32).toString("base64url")}`;
}

function profile(input: {
  readonly userId: string;
  readonly displayName: string;
  readonly email: string;
}): AccountProfileDto {
  return { id: input.userId, displayName: input.displayName, email: input.email };
}

export interface LocalAccountAuthService extends AuthContextResolver {
  register(input: RegisterAccountRequest): Promise<AccountSessionDto>;
  login(input: LoginAccountRequest): Promise<AccountSessionDto>;
  getProfile(principal: AuthPrincipal): Promise<AccountProfileDto | undefined>;
  logout(authorization: string | undefined): Promise<void>;
}

export function createLocalAccountAuthService(input: {
  readonly repository: LocalAccountRepository;
  readonly clock: ApiClock;
}): LocalAccountAuthService {
  const sessionExpiry = (createdAt: string): string =>
    new Date(new Date(createdAt).getTime() + sessionLifetimeMilliseconds).toISOString();

  const issueSession = async (account: {
    readonly userId: string;
    readonly personalTenantId: string;
    readonly displayName: string;
    readonly email: string;
  }): Promise<AccountSessionDto> => {
    const createdAt = input.clock.now();
    const expiresAt = sessionExpiry(createdAt);
    const accessToken = createSessionToken();
    await input.repository.createSession({
      tokenDigest: tokenDigest(accessToken),
      userId: account.userId,
      personalTenantId: account.personalTenantId,
      createdAt,
      expiresAt,
    });
    return { profile: profile(account), accessToken, expiresAt };
  };

  return Object.freeze({
    async register(request: RegisterAccountRequest) {
      const email = normalizeEmail(request.email);
      const displayName = normalizeDisplayName(request.displayName);
      validatePassword(request.password);
      const createdAt = input.clock.now();
      const expiresAt = sessionExpiry(createdAt);
      const accessToken = createSessionToken();
      const salt = randomBytes(passwordSaltLength);
      const hash = await derivePassword(request.password, salt);
      const identity = randomUUID();
      const account = {
        userId: `user_${identity}`,
        personalTenantId: `tenant_personal_${identity}`,
        membershipId: `membership_personal_${identity}`,
        email,
        displayName,
      } as const;
      const outcome = await input.repository.register({
        ...account,
        passwordAlgorithm,
        passwordSalt: salt,
        passwordHash: hash,
        sessionTokenDigest: tokenDigest(accessToken),
        createdAt,
        sessionExpiresAt: expiresAt,
      });
      if (outcome === "conflict") throw new ApiFailure("conflict");
      return { profile: profile(account), accessToken, expiresAt };
    },

    async login(request: LoginAccountRequest) {
      const email = normalizeEmail(request.email);
      validatePassword(request.password);
      const account = await input.repository.findByNormalizedEmail(email);
      const actualHash = await derivePassword(request.password, account?.passwordSalt ?? dummySalt);
      const expectedHash = Buffer.from(account?.passwordHash ?? dummyHash);
      if (account === undefined || !timingSafeEqual(actualHash, expectedHash)) {
        throw new ApiFailure("unauthorized");
      }
      return issueSession(account);
    },

    async resolve({ authorization }: { readonly authorization: string | undefined }) {
      const token = parseSessionToken(authorization);
      if (token === undefined) return undefined;
      const account = await input.repository.resolveSession(tokenDigest(token), input.clock.now());
      if (account === undefined) return undefined;
      return Object.freeze({
        userId: userId(account.userId),
        tenantId: tenantId(account.personalTenantId),
      });
    },

    async getProfile(principal: AuthPrincipal) {
      if (principal.tenantId === undefined) return undefined;
      const account = await input.repository.findProfileByUserId(
        principal.userId,
        principal.tenantId,
      );
      return account === undefined ? undefined : profile(account);
    },

    async logout(authorization: string | undefined) {
      const token = parseSessionToken(authorization);
      if (token !== undefined) await input.repository.revokeSession(tokenDigest(token));
    },
  });
}
