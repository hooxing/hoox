import type { Pool } from "pg";
import { withTransaction } from "./postgres.js";

export class PgInstallationRepository {
  constructor(private readonly pool: Pool) {}

  async initialized(): Promise<boolean> {
    const result = await this.pool.query<{ initialized: boolean }>(
      "SELECT initialized FROM installation_status",
    );
    if (result.rows.length !== 1) throw new Error("INSTALLATION_STATE_MISSING");
    return result.rows[0]!.initialized;
  }

  async canAccessControl(userId: string): Promise<boolean> {
    return this.hasRole(userId, false);
  }

  async canStartAdminSession(userId: string): Promise<boolean> {
    return withTransaction(this.pool, async (client) => {
      await client.query("SELECT set_config('app.user_id',$1,true)", [userId]);
      const result = await client.query<{ allowed: boolean }>(
        `SELECT EXISTS (
           SELECT 1 FROM platform_control_operators
            WHERE user_id=$1 AND status='active' AND role='admin'
         ) OR EXISTS (
           SELECT 1 FROM skill_namespace_publishers
            WHERE user_id=$1 AND revoked_at IS NULL
         ) AS allowed`,
        [userId],
      );
      return result.rows[0]?.allowed === true;
    });
  }

  async isAdministrator(userId: string): Promise<boolean> {
    return this.hasRole(userId, true);
  }

  private async hasRole(userId: string, administratorOnly: boolean): Promise<boolean> {
    return withTransaction(this.pool, async (client) => {
      await client.query("SELECT set_config('app.user_id',$1,true)", [userId]);
      const result = await client.query(
        "SELECT 1 FROM platform_control_operators WHERE user_id=$1 AND status='active' AND (NOT $2::boolean OR role='admin') UNION SELECT 1 FROM platform_skill_operators WHERE user_id=$1 AND status='active' AND NOT $2::boolean",
        [userId, administratorOnly],
      );
      return result.rowCount === 1;
    });
  }
}
