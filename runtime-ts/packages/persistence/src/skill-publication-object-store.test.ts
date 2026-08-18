import {
  type GetObjectCommand,
  HeadBucketCommand,
  HeadObjectCommand,
  PutObjectCommand,
} from "@aws-sdk/client-s3";
import { validateSkillPublicationPackage } from "@hoox/skill";
import { describe, expect, it } from "vitest";
import {
  S3StableSkillPublisher,
  type SkillPublicationS3Client,
} from "./skill-publication-object-store.js";

interface ObjectState {
  readonly body: Uint8Array;
  readonly mediaType: string;
  readonly sha256: string;
}

class MemoryS3 implements SkillPublicationS3Client {
  readonly objects = new Map<string, ObjectState>();
  readonly puts: PutObjectCommand[] = [];

  async send(command: HeadBucketCommand | HeadObjectCommand | PutObjectCommand | GetObjectCommand) {
    if (command instanceof HeadBucketCommand) return {};
    const key = String(command.input.Key);
    if (command instanceof HeadObjectCommand) {
      const value = this.objects.get(key);
      if (value === undefined) throw missing();
      return {
        ContentLength: value.body.byteLength,
        ContentType: value.mediaType,
        Metadata: { sha256: value.sha256 },
      };
    }
    if (command instanceof PutObjectCommand) {
      this.puts.push(command);
      if (this.objects.has(key)) throw precondition();
      const body = new Uint8Array(command.input.Body as Uint8Array);
      this.objects.set(key, {
        body,
        mediaType: String(command.input.ContentType),
        sha256: String(command.input.Metadata?.sha256),
      });
      return {};
    }
    const value = this.objects.get(key);
    if (value === undefined) throw missing();
    return {
      ContentLength: value.body.byteLength,
      Body: { transformToByteArray: async () => value.body.slice() },
    };
  }
}

describe("S3 管理 Skill 稳定对象发布", () => {
  it("以 If-None-Match 写入并经 HEAD、GET、哈希校验后返回 Runtime 可读引用", async () => {
    const client = new MemoryS3();
    const publisher = new S3StableSkillPublisher({
      bucket: "skill-bucket",
      region: "test-region",
      client,
    });
    const packageInput = publicationPackage("text/markdown");
    const stored = await publisher.publishPackage(packageInput);
    const entrypoint = stored.files[0];
    expect(entrypoint).toBeDefined();
    const reference = JSON.parse(entrypoint?.blobRef ?? "") as {
      readonly kind: string;
      readonly tenantId: string;
      readonly purpose: string;
      readonly physicalObjectKey: string;
    };
    expect(reference).toMatchObject({
      kind: "stable",
      tenantId: "skill_catalog",
      purpose: "skill",
    });
    expect(reference.physicalObjectKey).toContain(
      "agent-worker/stable/skill_catalog/skill/sha256/",
    );
    expect(client.puts.every((command) => command.input.IfNoneMatch === "*")).toBe(true);
    await expect(
      publisher.read({
        blobRef: entrypoint?.blobRef ?? "",
        expectedDigest: packageInput.entrypointDigest,
        expectedSizeBytes: packageInput.files[0]?.sizeBytes ?? -1,
      }),
    ).resolves.toEqual(packageInput.files[0]?.body);
    await expect(publisher.probe()).resolves.toBeUndefined();
  });

  it("相同正文即使媒体类型不同也复用同一内容身份", async () => {
    const client = new MemoryS3();
    const publisher = new S3StableSkillPublisher({
      bucket: "skill-bucket",
      region: "test-region",
      client,
    });
    const first = await publisher.publishPackage(publicationPackage("text/markdown"));
    const second = await publisher.publishPackage(publicationPackage("application/octet-stream"));
    const left = JSON.parse(first.files[0]?.blobRef ?? "") as Record<string, unknown>;
    const right = JSON.parse(second.files[0]?.blobRef ?? "") as Record<string, unknown>;
    expect(right.physicalObjectKey).toBe(left.physicalObjectKey);
    expect(right.mediaType).not.toBe(left.mediaType);
    expect(client.objects.size).toBe(3);
  });

  it("拒绝接受同一内容键下大小或摘要元数据不一致的既有对象", async () => {
    const client = new MemoryS3();
    const packageInput = publicationPackage("text/markdown");
    const digest = packageInput.files[0]?.contentDigest ?? "";
    const incarnation = uuidFor(digest);
    client.objects.set(
      `agent-worker/stable/skill_catalog/skill/sha256/${digest}/incarnations/${incarnation}`,
      { body: new Uint8Array([1]), mediaType: "text/plain", sha256: digest },
    );
    const publisher = new S3StableSkillPublisher({
      bucket: "skill-bucket",
      region: "test-region",
      client,
    });
    await expect(publisher.publishPackage(packageInput)).rejects.toThrow("HEAD 完整性校验失败");
  });
});

function publicationPackage(mediaType: string) {
  return validateSkillPublicationPackage({
    metadata: {
      canonicalKey: "test-skill",
      displayName: "测试 Skill",
      publisher: "Cube",
      version: "1.0.0",
      description: "测试稳定对象发布",
      compatibility: "runtime >= 1",
      sourceUrl: "https://example.invalid/skill",
      sourceRevision: "commit-1",
      licenseSpdx: "Apache-2.0",
    },
    files: [
      {
        path: "SKILL.md",
        mediaType,
        contentBase64: Buffer.from("# Test\n").toString("base64"),
      },
    ],
  });
}

function uuidFor(digest: string): string {
  const bytes = Uint8Array.from(Buffer.from(digest.slice(0, 32), "hex"));
  bytes[6] = ((bytes[6] ?? 0) & 0x0f) | 0x40;
  bytes[8] = ((bytes[8] ?? 0) & 0x3f) | 0x80;
  const hex = Buffer.from(bytes).toString("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

function missing() {
  return Object.assign(new Error("missing"), {
    name: "NotFound",
    $metadata: { httpStatusCode: 404 },
  });
}

function precondition() {
  return Object.assign(new Error("exists"), {
    name: "PreconditionFailed",
    $metadata: { httpStatusCode: 412 },
  });
}
