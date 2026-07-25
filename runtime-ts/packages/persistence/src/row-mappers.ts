import {
  rehydrateMembership,
  rehydrateRun,
  rehydrateTenant,
  rehydrateThread,
  rehydrateUser,
  rehydrateWorkspace,
  type Membership,
  type Run,
  type Tenant,
  type Thread,
  type User,
  type Workspace,
} from "@cube-runtime/domain";
import type { QueryResultRow } from "pg";
import type { TenantBundle } from "./ports.js";

function iso(value: unknown): string {
  if (value instanceof Date) return value.toISOString();
  if (typeof value === "string") return new Date(value).toISOString();
  throw new TypeError("数据库时间字段无效");
}

export function mapTenantBundle(row: QueryResultRow): TenantBundle {
  const user = rehydrateUser({ id: row.user_id, createdAt: iso(row.user_created_at) });
  const tenant = rehydrateTenant(
    {
      id: row.tenant_id,
      kind: row.tenant_kind,
      ...(row.owner_user_id === null ? {} : { ownerUserId: row.owner_user_id }),
      ...(row.display_name === null ? {} : { displayName: row.display_name }),
      ...(row.created_by_user_id === null ? {} : { createdByUserId: row.created_by_user_id }),
      createdAt: iso(row.tenant_created_at),
    },
    user,
  );
  const membership = rehydrateMembership(
    {
      id: row.membership_id,
      tenantId: row.tenant_id,
      userId: row.user_id,
      role: row.membership_role,
      status: row.membership_status,
      createdAt: iso(row.membership_created_at),
    },
    tenant,
    user,
  );
  return Object.freeze({ user, tenant, membership });
}

export function mapThread(
  row: QueryResultRow,
  tenant: Tenant,
  user: User,
  membership: Membership,
): Thread {
  return rehydrateThread(
    {
      id: row.thread_id,
      tenantId: row.tenant_id,
      createdByUserId: row.thread_created_by_user_id,
      title: row.thread_title,
      status: row.thread_status,
      createdAt: iso(row.thread_created_at),
      updatedAt: iso(row.thread_updated_at),
    },
    tenant,
    user,
    membership,
  );
}

export function mapRun(row: QueryResultRow, thread: Thread): Run {
  return rehydrateRun(
    {
      id: row.run_id,
      tenantId: row.tenant_id,
      threadId: row.thread_id,
      status: row.run_status,
      createdAt: iso(row.run_created_at),
      updatedAt: iso(row.run_updated_at),
    },
    thread,
  );
}

export function mapWorkspace(row: QueryResultRow, thread: Thread, writerRun?: Run): Workspace {
  return rehydrateWorkspace(
    {
      id: row.workspace_id,
      tenantId: row.tenant_id,
      threadId: row.thread_id,
      currentRevisionNumber: row.current_revision_number,
      ...(row.current_revision_id === null ? {} : { currentRevisionId: row.current_revision_id }),
      leaseEpoch: Number(row.lease_epoch),
      ...(row.lease_root_run_id === null
        ? {}
        : {
            writerLease: {
              rootRunId: row.lease_root_run_id,
              epoch: Number(row.lease_row_epoch),
              expiresAt: iso(row.lease_expires_at),
            },
          }),
      createdAt: iso(row.workspace_created_at),
      updatedAt: iso(row.workspace_updated_at),
    },
    thread,
    writerRun,
  );
}
