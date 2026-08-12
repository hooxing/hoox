import { tenantId, userId } from "@cube-runtime/domain";
import type { Pool } from "pg";
import { describe, expect, it } from "vitest";
import { PgPersonalizationSettingsRepository } from "./pg-personalization-settings.js";

class PersonalizationClient {
  releasedWith: unknown;

  constructor(
    private readonly kind: "personal" | "team",
    private readonly applyToTeamTasks: boolean,
    private readonly hasPersonalSetting = true,
  ) {}

  async query(sql: string) {
    if (sql.startsWith("BEGIN") || sql === "COMMIT" || sql === "ROLLBACK") {
      return { rows: [], rowCount: 0 };
    }
    if (sql.includes("set_config")) return { rows: [], rowCount: 1 };
    if (sql.includes("SELECT tenant.kind")) {
      return { rows: [{ kind: this.kind }], rowCount: 1 };
    }
    if (sql.includes("SELECT 1 FROM tenants")) {
      return { rows: [{}], rowCount: 1 };
    }
    if (sql.includes("FROM user_personalization_settings WHERE user_id")) {
      if (!this.hasPersonalSetting) return { rows: [], rowCount: 0 };
      return {
        rows: [
          {
            content: "回答尽量简洁",
            apply_to_team_tasks: this.applyToTeamTasks,
            version: "7",
            updated_at: "2026-08-12T00:00:00.000Z",
          },
        ],
        rowCount: 1,
      };
    }
    if (sql.includes("FROM team_personalization_settings setting")) {
      return {
        rows: [
          {
            tenant_id: "tenant-team",
            content: "团队默认使用 TypeScript",
            version: "4",
            updated_at: "2026-08-12T00:00:00.000Z",
            role: "member",
          },
        ],
        rowCount: 1,
      };
    }
    throw new Error(`未处理 SQL：${sql}`);
  }

  release(error?: unknown) {
    this.releasedWith = error;
  }
}

function repository(
  kind: "personal" | "team",
  applyToTeamTasks: boolean,
  hasPersonalSetting = true,
) {
  const client = new PersonalizationClient(kind, applyToTeamTasks, hasPersonalSetting);
  const pool = { connect: async () => client } as unknown as Pool;
  return new PgPersonalizationSettingsRepository(pool);
}

const teamScope = Object.freeze({
  tenantId: tenantId("tenant-team"),
  userId: userId("user-member"),
});

describe("PostgreSQL Run 个性化快照", () => {
  it("未保存个人设置时返回默认开启而不是把 LEFT JOIN 空值当作脏数据", async () => {
    await expect(
      repository("personal", true, false).getPersonal({
        scope: { tenantId: tenantId("tenant-personal"), userId: userId("user-member") },
      }),
    ).resolves.toEqual({ content: "", applyToTeamTasks: true, version: 0 });
  });

  it("团队任务默认同时携带团队和个人个性化", async () => {
    await expect(repository("team", true).resolveForRun({ scope: teamScope })).resolves.toEqual({
      team: { content: "团队默认使用 TypeScript", version: 4 },
      user: { content: "回答尽量简洁", version: 7 },
    });
  });

  it("用户关闭团队应用后，团队任务只携带团队个性化", async () => {
    await expect(repository("team", false).resolveForRun({ scope: teamScope })).resolves.toEqual({
      team: { content: "团队默认使用 TypeScript", version: 4 },
    });
  });

  it("个人任务不受团队应用开关影响，始终携带个人个性化", async () => {
    await expect(
      repository("personal", false).resolveForRun({
        scope: { tenantId: tenantId("tenant-personal"), userId: userId("user-member") },
      }),
    ).resolves.toEqual({ user: { content: "回答尽量简洁", version: 7 } });
  });
});
