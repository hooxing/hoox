import type { TSchema } from "typebox";

const runtimeSchemas = new WeakMap<TSchema, TSchema>();
const publicSchemas = new WeakMap<TSchema, TSchema>();

// 内部占位字段只参与 Pi 执行期校验；公开能力摘要、预算与 Provider 请求共用公开契约。
export function registerRuntimeToolParameters(publicSchema: TSchema, runtimeSchema: TSchema): void {
  runtimeSchemas.set(publicSchema, runtimeSchema);
  publicSchemas.set(runtimeSchema, publicSchema);
}

export function runtimeToolParameters(schema: TSchema): TSchema {
  return runtimeSchemas.get(schema) ?? schema;
}

export function publicToolParameters(schema: TSchema): TSchema;
export function publicToolParameters(schema: unknown): unknown;
export function publicToolParameters(schema: unknown): unknown {
  return typeof schema === "object" && schema !== null
    ? (publicSchemas.get(schema) ?? schema)
    : schema;
}
