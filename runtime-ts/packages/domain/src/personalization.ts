import { domainInvariant } from "./errors.js";

export const PERSONALIZATION_MAX_CHARACTERS = 2_000;
export const PERSONALIZATION_MAX_UTF8_BYTES = 8 * 1_024;

const FORBIDDEN_AUDIT_CHARACTERS = /[\p{Cc}\p{Cf}\p{Cs}]/u;
// FE0E/FE0F 是常用文本/emoji 呈现选择符；其余不可见填充与选择符不进入长期指令。
const FORBIDDEN_INVISIBLE_CODE_POINTS = new Set([0x034f, 0x115f, 0x1160, 0x3164, 0xffa0]);

export interface PersonalizationPreferenceSnapshot {
  readonly content: string;
  readonly version: number;
}

export interface RunPersonalizationSnapshot {
  readonly user?: PersonalizationPreferenceSnapshot;
  readonly team?: PersonalizationPreferenceSnapshot;
}

/**
 * 个性化会长期进入模型上下文，因此必须在 API、持久层读取和 Prompt 边界共享同一规范。
 * 空白值表示关闭；正文按 NFC 与 LF 固化，不做静默截断。
 */
export function normalizePersonalizationContent(raw: string): string {
  domainInvariant(typeof raw === "string", "INVALID_ARGUMENT", "个性化内容必须是字符串");
  const normalizedLineEndings = raw.replaceAll("\r\n", "\n").replaceAll("\r", "\n");
  const content = normalizedLineEndings.trim().normalize("NFC");
  if (content.length === 0) return "";
  domainInvariant(
    Array.from(content).length <= PERSONALIZATION_MAX_CHARACTERS,
    "INVALID_ARGUMENT",
    "个性化内容超过字符上限",
  );
  domainInvariant(
    new TextEncoder().encode(content).byteLength <= PERSONALIZATION_MAX_UTF8_BYTES,
    "INVALID_ARGUMENT",
    "个性化内容超过 UTF-8 字节上限",
  );
  for (const character of content) {
    const codePoint = character.codePointAt(0);
    const forbiddenControl = character !== "\n" && FORBIDDEN_AUDIT_CHARACTERS.test(character);
    const forbiddenInvisible =
      codePoint !== undefined &&
      (FORBIDDEN_INVISIBLE_CODE_POINTS.has(codePoint) ||
        (codePoint >= 0xfe00 && codePoint <= 0xfe0d) ||
        (codePoint >= 0xe0100 && codePoint <= 0xe01ef));
    domainInvariant(
      !forbiddenControl && !forbiddenInvisible,
      "INVALID_ARGUMENT",
      "个性化内容含控制、Bidi、零宽或非法 Unicode 字符",
    );
  }
  return content;
}

export function assertRunPersonalizationSnapshot(
  snapshot: RunPersonalizationSnapshot,
): RunPersonalizationSnapshot {
  const normalize = (
    value: PersonalizationPreferenceSnapshot | undefined,
  ): PersonalizationPreferenceSnapshot | undefined => {
    if (value === undefined) return undefined;
    const content = normalizePersonalizationContent(value.content);
    domainInvariant(content.length > 0, "INVALID_ARGUMENT", "Run 个性化快照不能包含空正文");
    domainInvariant(
      Number.isSafeInteger(value.version) && value.version > 0,
      "INVALID_ARGUMENT",
      "Run 个性化版本无效",
    );
    return Object.freeze({ content, version: value.version });
  };
  const user = normalize(snapshot.user);
  const team = normalize(snapshot.team);
  return Object.freeze({
    ...(team === undefined ? {} : { team }),
    ...(user === undefined ? {} : { user }),
  });
}
