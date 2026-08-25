import { describe, expect, it } from "vitest";
import { readAdminAccessToken } from "./admin-session.js";

function storage(value: string | null): Pick<Storage, "getItem"> {
  return { getItem: () => value };
}

describe("后台 Hoox 会话", () => {
  it("只读取未过期的 Hoox access token", () => {
    const serialized = JSON.stringify({
      accessToken: "hoox_session_demo-token",
      expiresAt: "2026-08-25T16:00:00.000Z",
    });
    expect(
      readAdminAccessToken(storage(serialized), () => Date.parse("2026-08-25T15:00:00Z")),
    ).toBe("hoox_session_demo-token");
    expect(
      readAdminAccessToken(storage(serialized), () => Date.parse("2026-08-25T17:00:00Z")),
    ).toBeUndefined();
  });

  it.each([
    null,
    "not-json",
    JSON.stringify({ accessToken: "other-token", expiresAt: "2099-01-01T00:00:00Z" }),
  ])("拒绝缺失或损坏的会话：%s", (serialized) => {
    expect(readAdminAccessToken(storage(serialized))).toBeUndefined();
  });
});
