import { domainInvariant } from "./errors.js";

export function recordValue(value: unknown, entityName: string): Record<string, unknown> {
  domainInvariant(
    typeof value === "object" && value !== null && !Array.isArray(value),
    "INVALID_ARGUMENT",
    `${entityName} 快照格式无效`,
  );
  return value as Record<string, unknown>;
}

export function stringValue(record: Record<string, unknown>, key: string): string {
  const value = record[key];
  domainInvariant(typeof value === "string", "INVALID_ARGUMENT", `${key} 字段格式无效`);
  return value;
}

export function optionalStringValue(
  record: Record<string, unknown>,
  key: string,
): string | undefined {
  const value = record[key];
  domainInvariant(
    value === undefined || typeof value === "string",
    "INVALID_ARGUMENT",
    `${key} 字段格式无效`,
  );
  return value;
}

export function integerValue(record: Record<string, unknown>, key: string): number {
  const value = record[key];
  domainInvariant(Number.isSafeInteger(value), "INVALID_ARGUMENT", `${key} 字段格式无效`);
  return value as number;
}

export function enumValue<const Values extends readonly string[]>(
  record: Record<string, unknown>,
  key: string,
  values: Values,
): Values[number] {
  const value = stringValue(record, key);
  domainInvariant(values.includes(value), "INVALID_ARGUMENT", `${key} 字段取值无效`);
  return value as Values[number];
}

export function arrayValue(record: Record<string, unknown>, key: string): readonly unknown[] {
  const value = record[key];
  domainInvariant(Array.isArray(value), "INVALID_ARGUMENT", `${key} 字段格式无效`);
  return value;
}
