import { createHash } from "node:crypto";
import {
  BrandingError,
  type BrandingAdminPort,
  type PublicBrandingPort,
} from "@hoox/admin-control";
import { normalizeBranding, type AdminBranding, type SaveBrandingRequest } from "@hoox/protocol";
import type { Pool, PoolClient } from "pg";
import { withTransaction } from "./postgres.js";

export class PgPublicBrandingRepository implements PublicBrandingPort {
  constructor(private readonly pool: Pool) {}
  async read() {
    const result = await this.pool.query("SELECT configuration FROM public_branding");
    return normalizeBranding(result.rows[0]?.configuration);
  }
}
export class PgBrandingRepository implements BrandingAdminPort {
  constructor(private readonly pool: Pool) {}
  async read(userId: string): Promise<AdminBranding> {
    return withTransaction(this.pool, async (client) => {
      await authorize(client, userId);
      return read(client);
    });
  }
  async save(userId: string, input: SaveBrandingRequest): Promise<AdminBranding> {
    const configuration = normalizeBranding(input.configuration);
    if (
      !Number.isInteger(input.expectedGeneration) ||
      input.expectedGeneration < 0 ||
      input.expectedGeneration > 2147483646 ||
      !/^[A-Za-z0-9_-]{8,128}$/.test(input.requestId)
    )
      throw new TypeError("品牌保存请求无效");
    const digest = createHash("sha256")
      .update(JSON.stringify({ expectedGeneration: input.expectedGeneration, configuration }))
      .digest("hex");
    return withTransaction(this.pool, async (client) => {
      await authorize(client, userId);
      await client.query("SELECT singleton FROM platform_branding FOR UPDATE");
      const previous = await client.query(
        "SELECT actor_user_id,input_digest,generation FROM platform_branding_audits WHERE request_id=$1",
        [input.requestId],
      );
      if (previous.rows[0]) {
        if (previous.rows[0].actor_user_id !== userId || previous.rows[0].input_digest !== digest)
          throw new BrandingError("conflict");
        return { generation: previous.rows[0].generation as number, configuration };
      }
      const updated = await client.query(
        "UPDATE platform_branding SET configuration=$1,generation=generation+1,updated_by=$2,updated_at=now() WHERE generation=$3 RETURNING generation",
        [configuration, userId, input.expectedGeneration],
      );
      if (!updated.rows[0]) throw new BrandingError("conflict");
      const generation = updated.rows[0].generation as number;
      await client.query(
        "INSERT INTO platform_branding_audits(request_id,actor_user_id,input_digest,generation) VALUES ($1,$2,$3,$4)",
        [input.requestId, userId, digest, generation],
      );
      return { generation, configuration };
    });
  }
}
async function authorize(client: PoolClient, userId: string): Promise<void> {
  await client.query("SELECT set_config('app.user_id',$1,true)", [userId]);
  const actor = await client.query(
    "SELECT 1 FROM platform_control_operators WHERE user_id=$1 AND role='admin' AND status='active'",
    [userId],
  );
  if (actor.rowCount !== 1) throw new BrandingError("forbidden");
}
async function read(client: PoolClient): Promise<AdminBranding> {
  const result = await client.query("SELECT generation,configuration FROM platform_branding");
  if (!result.rows[0]) throw new Error("BRANDING_STATE_MISSING");
  return {
    generation: result.rows[0].generation as number,
    configuration: normalizeBranding(result.rows[0].configuration),
  };
}
