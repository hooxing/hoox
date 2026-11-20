import { validateHeaderName, validateHeaderValue } from "node:http";
import {
  booleanEnvironmentField,
  EnvironmentConfigurationError,
  stringEnvironmentField,
} from "@hoox/process-runtime";
import type { WorkerTelemetry } from "./runtime.js";

export const telemetryEnvironmentFields = {
  OTEL_EXPORT_ENABLED: booleanEnvironmentField({ requiredIn: [] }),
  OTEL_EXPORT_ENDPOINT: stringEnvironmentField({ requiredIn: [], secret: true }),
  OTEL_EXPORT_HEADERS: stringEnvironmentField({ requiredIn: [], maxLength: 8192, secret: true }),
  OTEL_EXPORT_SAMPLE_RATE: stringEnvironmentField({ requiredIn: [] }),
  OTEL_EXPORT_CONTENT_ENABLED: booleanEnvironmentField({ requiredIn: [] }),
};

export interface TelemetryConfiguration {
  readonly endpoint: string;
  readonly headers: Readonly<Record<string, string>>;
  readonly sampleRate: number;
  readonly contentEnabled: boolean;
}

export function parseTelemetryConfiguration(values: {
  readonly OTEL_EXPORT_ENABLED?: boolean | undefined;
  readonly OTEL_EXPORT_ENDPOINT?: string | undefined;
  readonly OTEL_EXPORT_HEADERS?: string | undefined;
  readonly OTEL_EXPORT_SAMPLE_RATE?: string | undefined;
  readonly OTEL_EXPORT_CONTENT_ENABLED?: boolean | undefined;
}): TelemetryConfiguration | undefined {
  if (!values.OTEL_EXPORT_ENABLED) return undefined;
  const endpoint = readSetting("OTEL_EXPORT_ENDPOINT", values.OTEL_EXPORT_ENDPOINT, (raw) => {
    const url = new URL(raw);
    if (
      !/^https?:\/\//iu.test(raw) ||
      !["http:", "https:"].includes(url.protocol) ||
      url.username ||
      url.password ||
      /[?#]/u.test(raw)
    )
      throw new Error();
    return url.href.replace(/\/+$/u, "");
  });
  const headers = readSetting("OTEL_EXPORT_HEADERS", values.OTEL_EXPORT_HEADERS ?? "{}", (raw) => {
    const parsed: unknown = JSON.parse(raw);
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error();
    const headers: Record<string, string> = Object.create(null);
    for (const [name, value] of Object.entries(parsed)) {
      const lower = name.toLowerCase();
      if (
        typeof value !== "string" ||
        /[^\x20-\x7e]/u.test(value) ||
        Object.hasOwn(headers, lower) ||
        [
          "host",
          "connection",
          "content-type",
          "content-length",
          "content-encoding",
          "transfer-encoding",
        ].includes(lower)
      )
        throw new Error();
      validateHeaderName(name);
      validateHeaderValue(name, value);
      headers[lower] = value;
    }
    return Object.freeze(headers);
  });
  const sampleRate = readSetting(
    "OTEL_EXPORT_SAMPLE_RATE",
    values.OTEL_EXPORT_SAMPLE_RATE ?? "1",
    (raw) => {
      if (!/^(?:0(?:\.\d+)?|1(?:\.0+)?)$/u.test(raw)) throw new Error();
      return Number(raw);
    },
  );
  return Object.freeze({
    endpoint,
    headers,
    sampleRate,
    contentEnabled: values.OTEL_EXPORT_CONTENT_ENABLED === true,
  });
}

function readSetting<T>(
  key: keyof typeof telemetryEnvironmentFields,
  raw: string | undefined,
  parse: (value: string) => T,
): T {
  if (raw === undefined) throw new EnvironmentConfigurationError([{ code: "MISSING", key }]);
  try {
    return parse(raw);
  } catch {
    throw new EnvironmentConfigurationError([{ code: "INVALID", key }]);
  }
}

export async function assembleWorkerTelemetry(
  configuration: TelemetryConfiguration | undefined,
  load = () => import("./runtime.js"),
): Promise<WorkerTelemetry | undefined> {
  if (configuration === undefined) return undefined;
  const { createWorkerTelemetry } = await load();
  return createWorkerTelemetry(configuration);
}
