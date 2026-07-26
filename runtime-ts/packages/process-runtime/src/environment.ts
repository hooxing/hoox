export type RuntimeEnvironment = "development" | "test" | "production";

export type EnvironmentIssueCode = "MISSING" | "UNKNOWN" | "INVALID" | "FORBIDDEN_IN_PRODUCTION";

export interface EnvironmentIssue {
  readonly code: EnvironmentIssueCode;
  readonly key: string;
}

export class EnvironmentConfigurationError extends Error {
  readonly issues: readonly EnvironmentIssue[];

  constructor(issues: readonly EnvironmentIssue[]) {
    const normalized = [...issues].sort(
      (left, right) => left.key.localeCompare(right.key) || left.code.localeCompare(right.code),
    );
    // 错误只包含键名与稳定分类，秘密值和底层解析消息都不能越过配置边界。
    super(`环境配置无效：${normalized.map((issue) => `${issue.code}:${issue.key}`).join(",")}`);
    this.name = "EnvironmentConfigurationError";
    this.issues = Object.freeze(normalized);
  }
}

export interface EnvironmentField<T> {
  readonly requiredIn: ReadonlySet<RuntimeEnvironment>;
  readonly secret: boolean;
  parse(value: string): T;
}

type EnvironmentFields = Readonly<Record<string, EnvironmentField<unknown>>>;
type InferEnvironmentFields<TFields extends EnvironmentFields> = Readonly<{
  [TKey in keyof TFields]: TFields[TKey] extends EnvironmentField<infer TValue>
    ? TValue | undefined
    : never;
}>;

export interface ParsedEnvironment<TFields extends EnvironmentFields> {
  readonly runtimeEnvironment: RuntimeEnvironment;
  readonly values: InferEnvironmentFields<TFields>;
}

type ParsedEnvironmentValue<TFields extends EnvironmentFields, TKey extends keyof TFields> =
  TFields[TKey] extends EnvironmentField<infer TValue> ? TValue : never;

export interface EnvironmentFieldOptions {
  readonly requiredIn?: readonly RuntimeEnvironment[];
  readonly secret?: boolean;
}

const allRuntimeEnvironments = Object.freeze([
  "development",
  "test",
  "production",
] as const satisfies readonly RuntimeEnvironment[]);

function field<T>(
  parser: (value: string) => T,
  options: EnvironmentFieldOptions,
): EnvironmentField<T> {
  return Object.freeze({
    requiredIn: new Set(options.requiredIn ?? allRuntimeEnvironments),
    secret: options.secret ?? false,
    parse: parser,
  });
}

export function stringEnvironmentField(
  options: EnvironmentFieldOptions & {
    readonly minLength?: number;
    readonly maxLength?: number;
  } = {},
): EnvironmentField<string> {
  return field((value) => {
    const minimum = options.minLength ?? 1;
    const maximum = options.maxLength ?? 4_096;
    if (value.length < minimum || value.length > maximum || value.trim() !== value) {
      throw new TypeError("字符串配置无效");
    }
    return value;
  }, options);
}

export function booleanEnvironmentField(
  options: EnvironmentFieldOptions = {},
): EnvironmentField<boolean> {
  return field((value) => {
    if (value === "true") return true;
    if (value === "false") return false;
    throw new TypeError("布尔配置无效");
  }, options);
}

export function integerEnvironmentField(
  options: EnvironmentFieldOptions & {
    readonly minimum: number;
    readonly maximum: number;
  },
): EnvironmentField<number> {
  return field((value) => {
    if (!/^(0|[1-9][0-9]*)$/u.test(value)) throw new TypeError("整数配置无效");
    const parsed = Number(value);
    if (!Number.isSafeInteger(parsed) || parsed < options.minimum || parsed > options.maximum) {
      throw new TypeError("整数配置越界");
    }
    return parsed;
  }, options);
}

export function urlEnvironmentField(
  options: EnvironmentFieldOptions & {
    readonly protocols?: readonly string[];
    readonly allowCredentials?: boolean;
    readonly maxLength?: number;
  } = {},
): EnvironmentField<string> {
  return field((value) => {
    if (value.length > (options.maxLength ?? 2_048)) throw new TypeError("URL 配置过长");
    const parsed = new URL(value);
    const protocols = options.protocols ?? ["http:", "https:"];
    const hasCredentials = parsed.username !== "" || parsed.password !== "";
    if (!protocols.includes(parsed.protocol) || (hasCredentials && !options.allowCredentials)) {
      throw new TypeError("URL 配置无效");
    }
    return value;
  }, options);
}

function runtimeEnvironment(value: string | undefined): RuntimeEnvironment | undefined {
  return value === "development" || value === "test" || value === "production" ? value : undefined;
}

/**
 * 输入必须是应用已经声明的配置视图，而不是包含 PATH 等宿主变量的整个 process.env。
 * 调用方拼错关键键时，正确键会缺失并 fail closed；任何传入但未登记的键同样失败。
 */
export function parseStrictEnvironment<TFields extends EnvironmentFields>(
  source: Readonly<Record<string, string | undefined>>,
  fields: TFields,
): ParsedEnvironment<TFields> {
  if (Object.hasOwn(fields, "RUNTIME_ENV")) {
    throw new TypeError("RUNTIME_ENV 由严格解析器保留");
  }
  const issues: EnvironmentIssue[] = [];
  const environment = runtimeEnvironment(source.RUNTIME_ENV);
  if (source.RUNTIME_ENV === undefined) issues.push({ code: "MISSING", key: "RUNTIME_ENV" });
  else if (environment === undefined) issues.push({ code: "INVALID", key: "RUNTIME_ENV" });

  const knownKeys = new Set(["RUNTIME_ENV", ...Object.keys(fields)]);
  for (const key of Object.keys(source)) {
    if (!knownKeys.has(key)) issues.push({ code: "UNKNOWN", key });
  }

  const values: Record<string, unknown> = {};
  for (const [key, definition] of Object.entries(fields)) {
    const value = source[key];
    if (value === undefined || value.length === 0) {
      if (environment !== undefined && definition.requiredIn.has(environment)) {
        issues.push({ code: "MISSING", key });
      }
      values[key] = undefined;
      continue;
    }
    try {
      values[key] = definition.parse(value);
    } catch {
      issues.push({ code: "INVALID", key });
      values[key] = undefined;
    }
  }

  if (environment === "production" && values.DEV_AUTH_ENABLED === true) {
    issues.push({ code: "FORBIDDEN_IN_PRODUCTION", key: "DEV_AUTH_ENABLED" });
  }
  if (issues.length > 0 || environment === undefined)
    throw new EnvironmentConfigurationError(issues);
  return Object.freeze({
    runtimeEnvironment: environment,
    values: Object.freeze(values) as InferEnvironmentFields<TFields>,
  });
}

/** 只读取显式声明的键，宿主 PATH/CI 等变量不进入严格应用配置。 */
export function selectDeclaredEnvironment(
  source: NodeJS.ProcessEnv,
  keys: readonly string[],
): Readonly<Record<string, string | undefined>> {
  const selected: Record<string, string | undefined> = { RUNTIME_ENV: source.RUNTIME_ENV };
  for (const key of keys) selected[key] = source[key];
  return Object.freeze(selected);
}

/**
 * 在“字段由当前环境声明为必填”已经通过校验后，安全地读取配置值。
 * 这里仍保留防御性检查，避免后续调整 schema 时把 undefined 带进装配层。
 */
export function readRequiredEnvironmentValue<
  TFields extends EnvironmentFields,
  TKey extends keyof TFields,
>(parsed: ParsedEnvironment<TFields>, key: TKey): ParsedEnvironmentValue<TFields, TKey> {
  const value = parsed.values[key];
  if (value === undefined) {
    throw new EnvironmentConfigurationError([{ code: "MISSING", key: String(key) }]);
  }
  return value as ParsedEnvironmentValue<TFields, TKey>;
}
