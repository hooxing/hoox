import { resolvePackagePaths } from "./api.js";

const maxEntrypointBytes = 64 * 1024;
const canonicalKeyPattern = /^[a-z0-9][a-z0-9._-]{0,127}$/u;
const spdxIdentifierPattern = /^[A-Za-z0-9][A-Za-z0-9.+-]{0,99}$/u;

export interface SkillMetadataPrefill {
  readonly values: Readonly<{
    canonicalKey?: string;
    displayName?: string;
    publisher?: string;
    description?: string;
    sourceUrl?: string;
    sourceRevision?: string;
    licenseSpdx?: string;
  }>;
  readonly recognizedLabels: readonly string[];
  readonly licenseNotice?: string;
}

export class SkillMetadataError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SkillMetadataError";
  }
}

export async function extractSkillMetadataPrefill(
  files: readonly File[],
): Promise<SkillMetadataPrefill> {
  const packagePaths = resolvePackagePaths(files);
  const entrypointIndex = packagePaths.indexOf("SKILL.md");
  if (entrypointIndex < 0) {
    throw new SkillMetadataError("尚未找到根级 SKILL.md，无法自动识别元数据。");
  }
  const entrypoint = files[entrypointIndex];
  if (entrypoint === undefined || entrypoint.size === 0 || entrypoint.size > maxEntrypointBytes) {
    throw new SkillMetadataError("SKILL.md 为空或超过 64 KiB，无法自动识别元数据。");
  }

  let markdown: string;
  try {
    markdown = new TextDecoder("utf-8", { fatal: true }).decode(await entrypoint.arrayBuffer());
  } catch {
    throw new SkillMetadataError("SKILL.md 不是严格 UTF-8 文本，无法自动识别元数据。");
  }
  return prefillFromSkillMarkdown(markdown);
}

export function prefillFromSkillMarkdown(markdown: string): SkillMetadataPrefill {
  const metadata = parseFrontmatter(markdown);
  if (metadata === undefined) {
    throw new SkillMetadataError("SKILL.md 未包含可识别的 YAML Front Matter。");
  }

  const name = bounded(metadata.name, 200);
  const displayName = bounded(metadata.display_name ?? metadata.title ?? name, 200);
  const canonicalKey = name === undefined ? undefined : toCanonicalKey(name);
  const description = bounded(metadata.description, 2_048);
  const publisher = bounded(metadata.publisher, 200);
  const sourceUrl = safeSourceUrl(metadata.source_url ?? metadata.source);
  const sourceRevision = bounded(metadata.source_revision ?? metadata.revision, 200);
  const license = bounded(metadata.license, 2_048);
  const licenseSpdx = toLicenseIdentifier(license);

  const values = Object.freeze({
    ...(canonicalKey === undefined ? {} : { canonicalKey }),
    ...(displayName === undefined ? {} : { displayName }),
    ...(publisher === undefined ? {} : { publisher }),
    ...(description === undefined ? {} : { description }),
    ...(sourceUrl === undefined ? {} : { sourceUrl }),
    ...(sourceRevision === undefined ? {} : { sourceRevision }),
    ...(licenseSpdx === undefined ? {} : { licenseSpdx }),
  });
  const labels = Object.freeze(
    [
      [canonicalKey, "规范键"],
      [displayName, "显示名称"],
      [publisher, "发布者"],
      [description, "描述"],
      [sourceUrl, "上游仓库地址"],
      [sourceRevision, "上游提交/版本"],
      [licenseSpdx, "许可证"],
    ]
      .filter(([value]) => value !== undefined)
      .map(([, label]) => label as string),
  );

  return Object.freeze({
    values,
    recognizedLabels: labels,
    ...(license !== undefined && licenseSpdx === "LicenseRef-Proprietary"
      ? {
          licenseNotice:
            "检测到 Proprietary 声明，已映射为 LicenseRef-Proprietary；完整条款仍以包内 LICENSE 文件和 SKILL.md 为准。",
        }
      : {}),
  });
}

function parseFrontmatter(markdown: string): Readonly<Record<string, string>> | undefined {
  const lines = markdown
    .replace(/^\uFEFF/u, "")
    .replaceAll("\r\n", "\n")
    .split("\n");
  if (lines[0]?.trim() !== "---") return undefined;
  const closingIndex = lines.findIndex((line, index) => index > 0 && line.trim() === "---");
  if (closingIndex < 0) return undefined;

  const result: Record<string, string> = {};
  for (let index = 1; index < closingIndex; index += 1) {
    const line = lines[index];
    const match = line?.match(/^([A-Za-z][A-Za-z0-9_-]{0,63}):(?:\s*(.*))?$/u);
    if (match === null || match === undefined) continue;
    const key = match[1]?.toLocaleLowerCase("en-US");
    const rawValue = match[2]?.trim() ?? "";
    if (key === undefined) continue;
    if (
      rawValue === ">" ||
      rawValue === "|" ||
      rawValue.startsWith(">-") ||
      rawValue.startsWith("|-")
    ) {
      const block: string[] = [];
      while (index + 1 < closingIndex) {
        const next = lines[index + 1];
        if (next === undefined || (next.length > 0 && !/^\s/u.test(next))) break;
        index += 1;
        block.push(next.replace(/^\s+/u, ""));
      }
      result[key] = rawValue.startsWith(">") ? block.join(" ").trim() : block.join("\n").trim();
      continue;
    }
    const scalar = parseScalar(rawValue);
    if (scalar !== undefined) result[key] = scalar;
  }
  return Object.freeze(result);
}

function parseScalar(value: string): string | undefined {
  if (value.length === 0 || value === "null" || value === "~") return undefined;
  if (value.startsWith('"') && value.endsWith('"')) {
    try {
      const parsed: unknown = JSON.parse(value);
      return typeof parsed === "string" ? parsed : undefined;
    } catch {
      return undefined;
    }
  }
  if (value.startsWith("'") && value.endsWith("'")) {
    return value.slice(1, -1).replaceAll("''", "'");
  }
  const commentIndex = value.search(/\s+#/u);
  return (commentIndex < 0 ? value : value.slice(0, commentIndex)).trim();
}

function bounded(value: string | undefined, maxLength: number): string | undefined {
  const normalized = value?.trim().normalize("NFC");
  return normalized !== undefined && normalized.length > 0 && normalized.length <= maxLength
    ? normalized
    : undefined;
}

function toCanonicalKey(name: string): string | undefined {
  const candidate = name
    .normalize("NFKC")
    .toLocaleLowerCase("en-US")
    .replace(/\s+/gu, "-")
    .replace(/[^a-z0-9._-]+/gu, "-")
    .replace(/^[^a-z0-9]+|[^a-z0-9._-]+$/gu, "")
    .replace(/-{2,}/gu, "-")
    .slice(0, 128);
  return canonicalKeyPattern.test(candidate) ? candidate : undefined;
}

function toLicenseIdentifier(license: string | undefined): string | undefined {
  if (license === undefined) return undefined;
  if (/^proprietary(?:[.\s]|$)/iu.test(license)) return "LicenseRef-Proprietary";
  if (spdxIdentifierPattern.test(license)) return license;
  const leadingIdentifier = license.match(
    /^([A-Za-z0-9][A-Za-z0-9.+-]{0,99})(?:\s+License)?(?:[.\s]|$)/u,
  )?.[1];
  return leadingIdentifier !== undefined && spdxIdentifierPattern.test(leadingIdentifier)
    ? leadingIdentifier
    : undefined;
}

function safeSourceUrl(value: string | undefined): string | undefined {
  const candidate = bounded(value, 2_048);
  if (candidate === undefined) return undefined;
  try {
    const url = new URL(candidate);
    return (url.protocol === "https:" || url.protocol === "http:") &&
      url.username.length === 0 &&
      url.password.length === 0
      ? candidate
      : undefined;
  } catch {
    return undefined;
  }
}
