import { describe, expect, it } from "vitest";
import { parseProductionPostgresTransport } from "./production-postgres-transport.js";

describe("生产 PostgreSQL TLS 传输契约", () => {
  it("只接受单一 verify-full，并把 TLS 验证作为显式 pg 配置返回", () => {
    expect(
      parseProductionPostgresTransport(
        "postgresql://runtime:credential@database.example.invalid:5432/runtime?sslmode=verify-full",
      ),
    ).toEqual({
      connectionString: "postgresql://runtime:credential@database.example.invalid:5432/runtime",
      ssl: { rejectUnauthorized: true },
    });
  });

  it.each(["disable", "prefer", "require", "verify-ca", "no-verify"])(
    "拒绝不可验证或不完整的 sslmode=%s",
    (sslmode) => {
      expect(() =>
        parseProductionPostgresTransport(
          `postgresql://runtime:credential@database:5432/runtime?sslmode=${sslmode}`,
        ),
      ).toThrow("PRODUCTION_DATABASE_TRANSPORT_INVALID");
    },
  );

  it.each([
    "postgresql://runtime:credential@database:5432/runtime",
    "postgresql://runtime:credential@database:5432/runtime?sslmode=verify-full&sslmode=verify-full",
    "postgresql://runtime:credential@database:5432/runtime?sslmode=verify-full&options=-c%20search_path%3Dpublic",
    "postgresql://runtime:credential@database:5432/runtime?sslmode=verify-full&application_name=forged",
    "postgresql://runtime:credential@database:5432/runtime?sslmode=verify-full&sslrootcert=/tmp/forged.pem",
    "postgresql://runtime:credential@database:5432/runtime?SSLMODE=verify-full",
    "postgresql://runtime@database:5432/runtime?sslmode=verify-full",
    "postgresql://runtime:credential@database/runtime?sslmode=verify-full",
    "postgresql://runtime:credential@database:0/runtime?sslmode=verify-full",
    "postgresql://runtime:credential@database:65536/runtime?sslmode=verify-full",
  ])("拒绝缺失、重复、同义或会话覆盖参数：%s", (value) => {
    expect(() => parseProductionPostgresTransport(value)).toThrow(
      "PRODUCTION_DATABASE_TRANSPORT_INVALID",
    );
  });
});
