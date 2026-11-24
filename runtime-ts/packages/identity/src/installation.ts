import { timingSafeEqual } from "node:crypto";

export interface InstallationRepository {
  initialized(): Promise<boolean>;
  isAdministrator(userId: string): Promise<boolean>;
  canStartAdminSession(userId: string): Promise<boolean>;
  canAccessControl(userId: string): Promise<boolean>;
}

export function installationAccessAllowed(input: {
  readonly runtimeEnvironment: string;
  readonly configuredToken?: string;
  readonly suppliedToken?: string;
  readonly remoteAddress: string;
  readonly host: string;
  readonly origin?: string;
  readonly forwarded: boolean;
}): boolean {
  if (input.configuredToken !== undefined) {
    const expected = Buffer.from(input.configuredToken);
    const actual = Buffer.from(input.suppliedToken ?? "");
    return expected.length === actual.length && timingSafeEqual(expected, actual);
  }
  // 本地自动初始化仅对直接回环访问开放；生产或经代理的安装必须证明部署令牌。
  if (input.runtimeEnvironment === "production" || input.forwarded) return false;
  const loopback = (value: string) => value === "127.0.0.1" || value === "::1" || value === "[::1]";
  if (!loopback(input.remoteAddress)) return false;
  try {
    if (!loopback(new URL(`http://${input.host}`).hostname)) return false;
    return input.origin === undefined || loopback(new URL(input.origin).hostname);
  } catch {
    return false;
  }
}

export class InstallationAttemptLimiter {
  private readonly attempts = new Map<string, { count: number; expiresAt: number }>();

  accept(key: string, now = Date.now()): boolean {
    const previous = this.attempts.get(key);
    if (previous !== undefined && previous.expiresAt > now) {
      if (previous.count >= 10) return false;
      previous.count += 1;
      return true;
    }
    if (this.attempts.size >= 1024) {
      for (const [candidate, state] of this.attempts) {
        if (state.expiresAt <= now) this.attempts.delete(candidate);
      }
      if (this.attempts.size >= 1024) return false;
    }
    this.attempts.set(key, { count: 1, expiresAt: now + 60_000 });
    return true;
  }
}
