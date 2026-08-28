import type { Pool, PoolClient } from "pg";
import { describe, expect, it, vi } from "vitest";
import { PgRenamePersonalThreadCommand } from "./pg-core-repositories.js";

const now = "2026-08-28T03:30:00.000Z";

function successPool() {
  const query = vi.fn(async (text: string, _values?: readonly unknown[]) => {
    if (text.includes("FROM tenants AS tenant")) {
      return { rows: [{ kind: "personal", role: "owner", status: "active" }], rowCount: 1 };
    }
    if (text.includes("SELECT status FROM threads")) {
      return { rows: [{ status: "active" }], rowCount: 1 };
    }
    if (text.includes("FROM threads th")) {
      return {
        rows: [
          {
            tenant_id: "tenant_personal",
            tenant_kind: "personal",
            owner_user_id: "user_personal",
            display_name: null,
            created_by_user_id: "user_personal",
            tenant_created_at: "2026-08-27T00:00:00.000Z",
            tenant_actor_id: "user_personal",
            tenant_actor_created_at: "2026-08-27T00:00:00.000Z",
            thread_id: "thread_personal",
            thread_created_by_user_id: "user_personal",
            thread_title: "旧名称",
            thread_status: "active",
            thread_version: "4",
            thread_created_at: "2026-08-27T01:00:00.000Z",
            thread_updated_at: "2026-08-27T01:00:00.000Z",
            thread_creator_id: "user_personal",
            thread_creator_created_at: "2026-08-27T00:00:00.000Z",
            thread_creator_membership_id: "membership_personal",
            thread_creator_membership_role: "owner",
            thread_creator_membership_status: "active",
            thread_creator_membership_created_at: "2026-08-27T00:00:00.000Z",
          },
        ],
        rowCount: 1,
      };
    }
    if (text.includes("SELECT clock_timestamp() AS now")) {
      return { rows: [{ now }], rowCount: 1 };
    }
    if (text.includes("UPDATE threads")) {
      return { rows: [], rowCount: 1 };
    }
    return { rows: [], rowCount: null };
  });
  const release = vi.fn();
  const pool = {
    connect: async () => ({ query, release }) as unknown as PoolClient,
  } as unknown as Pool;
  return { pool, query, release };
}

describe("PostgreSQL 个人任务管理", () => {
  it("改名在授权锁内把标题来源切为 user，并使异步标题版本失效", async () => {
    const fixture = successPool();
    const result = await new PgRenamePersonalThreadCommand(fixture.pool).renamePersonalThread({
      scope: { tenantId: "tenant_personal", userId: "user_personal" } as never,
      threadId: "thread_personal" as never,
      title: "  新名称  ",
    });

    expect(result).toMatchObject({
      outcome: "renamed",
      entity: { title: "新名称", updatedAt: now },
    });
    const update = fixture.query.mock.calls.find(([text]) =>
      String(text).includes("UPDATE threads"),
    );
    expect(update?.[0]).toContain("title_source = 'user'");
    expect(update?.[0]).toContain("title_generation_version = title_generation_version + 1");
    expect(update?.[1]).toEqual(["tenant_personal", "thread_personal", "新名称", now]);
    expect(fixture.release).toHaveBeenCalledOnce();
  });
});
