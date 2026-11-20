import {
  type AgentRevisionContent,
  sha256Digest,
  type Sha256Digest,
  validateAgentRevisionContent,
} from "@hoox/domain";
import { createHash } from "node:crypto";

export interface RunAgentSnapshot {
  readonly definitionId: string;
  readonly revisionId: string;
  readonly revisionDigest: Sha256Digest;
  readonly content: AgentRevisionContent;
}

export type RunAgentStopCode = "AGENT_SNAPSHOT_INVALID" | "AGENT_REVISION_REVOKED";

// 已发布 Revision 的摘要直接编码规范化 JSON，不能改用先构造对象再序列化的顺序。
function canonicalRevision(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalRevision).join(",")}]`;
  return `{${Object.entries(value)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([key, item]) => `${JSON.stringify(key)}:${canonicalRevision(item)}`)
    .join(",")}}`;
}

export function digestAgentRevisionContent(content: AgentRevisionContent): Sha256Digest {
  return sha256Digest(createHash("sha256").update(canonicalRevision(content)).digest("hex"));
}

export function verifyRunAgentContent(
  content: AgentRevisionContent,
  revisionDigest: string,
): AgentRevisionContent {
  if (digestAgentRevisionContent(content) !== revisionDigest) {
    throw new Error("AGENT_SNAPSHOT_INVALID");
  }
  return validateAgentRevisionContent(content);
}
