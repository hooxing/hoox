import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import type { TokenizerPort } from "@cube-runtime/context-policy";
import { Tokenizer } from "@huggingface/tokenizers";

const TOKENIZER_JSON_SHA256 = "8f9f37ca37fdc4f5fd36d5cf4d3b0e8392edb4e894fd10cc0d70b4957c8633cf";
const TOKENIZER_CONFIG_SHA256 = "6ac8c8dc065ed118161d02dd532749ae3f52c243deac27872134fae2f50d8547";
const DEEPSEEK_V4_MODEL_ID = /^deepseek-v4(?:-|$)/iu;
const TRUSTED_TOKENIZERS = new WeakSet<object>();

export interface TrustedModelTokenizerCapability extends TokenizerPort {
  readonly modelFamily: "deepseek-v4";
  readonly sourceRevision: "a7aaed80dd2df27620eb534454253ea25eb11c7a";
}

let cachedDeepSeekV4Tokenizer: Promise<TrustedModelTokenizerCapability> | undefined;

/** Worker 装配只能从固定的模型/tokenizer 注册表取得能力，未知模型失败关闭。 */
export function loadTrustedModelTokenizerCapability(
  modelId: string,
): Promise<TrustedModelTokenizerCapability> {
  if (!DEEPSEEK_V4_MODEL_ID.test(modelId)) {
    throw new TypeError(`MODEL_TOKENIZER_UNSUPPORTED:${modelId}`);
  }
  cachedDeepSeekV4Tokenizer ??= loadDeepSeekV4Tokenizer();
  return cachedDeepSeekV4Tokenizer;
}

export function isTrustedModelTokenizerCapability(
  tokenizer: TokenizerPort,
): tokenizer is TrustedModelTokenizerCapability {
  return TRUSTED_TOKENIZERS.has(tokenizer as object);
}

async function loadDeepSeekV4Tokenizer(): Promise<TrustedModelTokenizerCapability> {
  const [tokenizerBytes, configurationBytes] = await Promise.all([
    readFile(new URL("../../../vendor/deepseek-v4-tokenizer/tokenizer.json", import.meta.url)),
    readFile(
      new URL("../../../vendor/deepseek-v4-tokenizer/tokenizer_config.json", import.meta.url),
    ),
  ]);
  assertDigest(tokenizerBytes, TOKENIZER_JSON_SHA256, "tokenizer.json");
  assertDigest(configurationBytes, TOKENIZER_CONFIG_SHA256, "tokenizer_config.json");
  const tokenizer = new Tokenizer(
    JSON.parse(tokenizerBytes.toString("utf8")) as Record<string, unknown>,
    JSON.parse(configurationBytes.toString("utf8")) as Record<string, unknown>,
  );
  const capability: TrustedModelTokenizerCapability = Object.freeze({
    modelFamily: "deepseek-v4",
    sourceRevision: "a7aaed80dd2df27620eb534454253ea25eb11c7a",
    identity: "deepseek-v4@a7aaed80-tokenizer-v1",
    countTokens(text: string): number {
      if (text.length === 0) return 0;
      const count = tokenizer.encode(text, { add_special_tokens: false }).ids.length;
      if (!Number.isSafeInteger(count) || count <= 0) {
        throw new TypeError("DeepSeek V4 tokenizer 返回了无效计数");
      }
      return count;
    },
  });
  TRUSTED_TOKENIZERS.add(capability);
  return capability;
}

function assertDigest(bytes: Buffer, expected: string, file: string): void {
  const actual = createHash("sha256").update(bytes).digest("hex");
  if (actual !== expected) throw new Error(`DEEPSEEK_V4_TOKENIZER_DIGEST_MISMATCH:${file}`);
}
