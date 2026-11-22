import { mkdir, readFile, writeFile } from "node:fs/promises";
import { execFileSync } from "node:child_process";
import {
  ArtifactDeliverySuccessEnvelopeSchema,
  ArtifactListSuccessEnvelopeSchema,
  AvailableAgentListSuccessEnvelopeSchema,
  CreateRunRequestSchema,
  CreateThreadRequestSchema,
  ErrorEnvelopeSchema,
  RunEventPageSuccessEnvelopeSchema,
  RunEventListQuerySchema,
  RunEventStreamQuerySchema,
  RunPathSchema,
  RunArtifactPathSchema,
  ResourceDownloadPathSchema,
  ResourceDownloadSuccessEnvelopeSchema,
  RunSuccessEnvelopeSchema,
  ThreadListQuerySchema,
  ThreadPageSuccessEnvelopeSchema,
  ThreadPathSchema,
  ThreadRunListQuerySchema,
  ThreadRunPageSuccessEnvelopeSchema,
  ThreadSuccessEnvelopeSchema,
  UploadedResourceSuccessEnvelopeSchema,
} from "../runtime-ts/packages/protocol/src/index.ts";

const target = new URL("../docs/reference/openapi/public-v1.json", import.meta.url);
const json = (schema) => ({ "application/json": { schema: cleanSchema(schema) } });
const operations = [
  {
    method: "get",
    path: "/v1/agents",
    id: "listAgents",
    summary: "列出当前空间可用 Agent",
    scope: "threads:read",
    response: AvailableAgentListSuccessEnvelopeSchema,
  },
  {
    method: "post",
    path: "/v1/threads",
    id: "createThread",
    summary: "创建 Thread",
    scope: "threads:create",
    body: CreateThreadRequestSchema,
    response: ThreadSuccessEnvelopeSchema,
    idempotent: true,
  },
  {
    method: "get",
    path: "/v1/threads",
    id: "listThreads",
    summary: "分页列出 Thread",
    scope: "threads:read",
    query: ThreadListQuerySchema,
    response: ThreadPageSuccessEnvelopeSchema,
  },
  {
    method: "get",
    path: "/v1/threads/{threadId}",
    id: "getThread",
    summary: "查询 Thread",
    scope: "threads:read",
    params: ThreadPathSchema,
    response: ThreadSuccessEnvelopeSchema,
  },
  {
    method: "get",
    path: "/v1/threads/{threadId}/runs",
    id: "listThreadRuns",
    summary: "列出 Thread 的最近 Run",
    scope: "runs:read",
    params: ThreadPathSchema,
    query: ThreadRunListQuerySchema,
    response: ThreadRunPageSuccessEnvelopeSchema,
  },
  {
    method: "post",
    path: "/v1/threads/{threadId}/runs",
    id: "createRun",
    summary: "创建 Run",
    scope: "runs:create",
    params: ThreadPathSchema,
    body: CreateRunRequestSchema,
    response: RunSuccessEnvelopeSchema,
    idempotent: true,
  },
  {
    method: "get",
    path: "/v1/threads/{threadId}/runs/{runId}",
    id: "getRun",
    summary: "查询 Run",
    scope: "runs:read",
    params: RunPathSchema,
    response: RunSuccessEnvelopeSchema,
  },
  {
    method: "delete",
    path: "/v1/threads/{threadId}/runs/{runId}",
    id: "cancelRun",
    summary: "取消 Run",
    scope: "runs:create",
    params: RunPathSchema,
    response: RunSuccessEnvelopeSchema,
  },
  {
    method: "get",
    path: "/v1/threads/{threadId}/runs/{runId}/events",
    id: "listRunEvents",
    summary: "分页读取 Run 事件",
    scope: "runs:read",
    params: RunPathSchema,
    query: RunEventListQuerySchema,
    response: RunEventPageSuccessEnvelopeSchema,
  },
  {
    method: "get",
    path: "/v1/threads/{threadId}/runs/{runId}/events/stream",
    id: "streamRunEvents",
    summary: "订阅 Run 事件",
    scope: "runs:read",
    params: RunPathSchema,
    query: RunEventStreamQuerySchema,
    sse: true,
  },
  {
    method: "post",
    path: "/v1/resources/uploads",
    id: "uploadResource",
    summary: "上传文件",
    scope: "runs:create",
    binaryBody: true,
    response: UploadedResourceSuccessEnvelopeSchema,
    idempotent: true,
  },
  {
    method: "get",
    path: "/v1/resources/{resourceId}/versions/{versionId}/download",
    id: "downloadResource",
    summary: "下载已上传文件",
    scope: "runs:read",
    params: ResourceDownloadPathSchema,
    response: ResourceDownloadSuccessEnvelopeSchema,
  },
  {
    method: "get",
    path: "/v1/threads/{threadId}/runs/{runId}/artifacts",
    id: "listArtifacts",
    summary: "列出已发布 Artifact",
    scope: "runs:read",
    params: RunPathSchema,
    response: ArtifactListSuccessEnvelopeSchema,
  },
  {
    method: "get",
    path: "/v1/threads/{threadId}/runs/{runId}/artifacts/{artifactId}/preview",
    id: "previewArtifact",
    summary: "预览 Artifact",
    scope: "runs:read",
    params: RunArtifactPathSchema,
    response: ArtifactDeliverySuccessEnvelopeSchema,
  },
  {
    method: "get",
    path: "/v1/threads/{threadId}/runs/{runId}/artifacts/{artifactId}/download",
    id: "downloadArtifact",
    summary: "下载 Artifact",
    scope: "runs:read",
    params: RunArtifactPathSchema,
    response: ArtifactDeliverySuccessEnvelopeSchema,
  },
  {
    method: "get",
    path: "/v1/threads/{threadId}/runs/{runId}/artifacts/{artifactId}/content",
    id: "readArtifactContent",
    summary: "读取 Artifact 原始内容",
    scope: "runs:read",
    params: RunArtifactPathSchema,
    binaryResponse: true,
  },
];

const schemaComponents = {};

function cleanSchema(schema) {
  if (Array.isArray(schema)) return schema.map(cleanSchema);
  if (schema === null || typeof schema !== "object") return schema;
  if (typeof schema.$id === "string") {
    const name = schema.$id;
    if (schemaComponents[name] === undefined) {
      schemaComponents[name] = {};
      schemaComponents[name] = cleanSchema(
        Object.fromEntries(Object.entries(schema).filter(([key]) => key !== "$id")),
      );
    }
    return { $ref: `#/components/schemas/${name}` };
  }
  return Object.fromEntries(
    Object.entries(schema)
      .filter(([key]) => key !== "$id" && key !== "$schema")
      .map(([key, value]) => [key, cleanSchema(value)]),
  );
}

function schemaParameters(schema, location) {
  if (schema === undefined) return [];
  return Object.entries(schema.properties ?? {}).map(([name, property]) => ({
    name,
    in: location,
    required: location === "path" || (schema.required ?? []).includes(name),
    description: property.description,
    schema: cleanSchema(property),
  }));
}

function operation(item) {
  const parameters = [
    ...schemaParameters(item.params, "path"),
    ...schemaParameters(item.query, "query"),
    ...(item.idempotent
      ? [
          {
            name: "Idempotency-Key",
            in: "header",
            required: true,
            schema: {
              type: "string",
              minLength: 8,
              maxLength: 128,
              pattern: "^[A-Za-z0-9][A-Za-z0-9._:-]{7,127}$",
            },
          },
        ]
      : []),
    ...(item.id === "streamRunEvents"
      ? [
          {
            name: "Last-Event-ID",
            in: "header",
            required: false,
            description: "SSE 续连游标；格式为 attemptId-sequence。",
            schema: { type: "string" },
          },
        ]
      : []),
    ...(item.id === "uploadResource"
      ? [
          {
            name: "X-File-Name",
            in: "header",
            required: true,
            schema: { type: "string", maxLength: 1024 },
          },
          {
            name: "X-File-Media-Type",
            in: "header",
            required: false,
            schema: { type: "string", maxLength: 255 },
          },
        ]
      : []),
  ];
  const responses = {
    200: {
      description: "成功",
      content: item.sse
        ? { "text/event-stream": { schema: { type: "string" } } }
        : item.binaryResponse
          ? { "application/octet-stream": { schema: { type: "string", format: "binary" } } }
          : json(item.response),
    },
    400: { description: "请求参数无效", content: json(ErrorEnvelopeSchema) },
    401: { description: "认证失败", content: json(ErrorEnvelopeSchema) },
    403: { description: "作用域不足", content: json(ErrorEnvelopeSchema) },
    404: { description: "资源不存在或不可见", content: json(ErrorEnvelopeSchema) },
    500: { description: "内部错误", content: json(ErrorEnvelopeSchema) },
    503: { description: "依赖暂不可用", content: json(ErrorEnvelopeSchema) },
  };
  if (item.idempotent) {
    responses[409] = {
      description: "幂等键冲突或资源状态冲突",
      content: json(ErrorEnvelopeSchema),
    };
  }
  if (["createThread", "createRun", "uploadResource"].includes(item.id)) {
    responses[415] = { description: "不支持的媒体类型", content: json(ErrorEnvelopeSchema) };
  }
  if (["cancelRun", "previewArtifact", "downloadArtifact"].includes(item.id)) {
    responses[422] = { description: "当前状态不支持该操作", content: json(ErrorEnvelopeSchema) };
  }
  return {
    operationId: item.id,
    summary: item.summary,
    tags: ["Public v1"],
    security: [{ bearerAuth: [] }],
    "x-hoox-api-key-scope": item.scope,
    ...(parameters.length === 0 ? {} : { parameters }),
    ...(item.body === undefined && !item.binaryBody
      ? {}
      : {
          requestBody: {
            required: true,
            content: item.binaryBody
              ? { "application/octet-stream": { schema: { type: "string", format: "binary" } } }
              : json(item.body),
          },
        }),
    responses,
  };
}

const document = {
  openapi: "3.1.0",
  info: {
    title: "Hoox Public API",
    version: "1.0.0",
    description: "Hoox 对外承诺的 v1 API。内部工作台路由不属于此兼容契约。",
  },
  security: [{ bearerAuth: [] }],
  components: {
    securitySchemes: {
      bearerAuth: { type: "http", scheme: "bearer", bearerFormat: "Hoox API Key" },
    },
    schemas: schemaComponents,
  },
  paths: operations.reduce((paths, item) => {
    paths[item.path] ??= {};
    paths[item.path][item.method] = operation(item);
    return paths;
  }, {}),
};

const output = execFileSync(
  "corepack",
  ["pnpm", "exec", "biome", "format", "--stdin-file-path", "docs/reference/openapi/public-v1.json"],
  { input: `${JSON.stringify(document, null, 2)}\n`, encoding: "utf8" },
);
if (process.argv.includes("--check")) {
  const current = await readFile(target, "utf8").catch(() => "");
  if (current !== output) {
    console.error(
      "公开 API OpenAPI 文档与 protocol Schema 不一致；运行 pnpm api:openapi:generate 更新。",
    );
    process.exitCode = 1;
  }
} else {
  await mkdir(new URL("../docs/reference/openapi/", import.meta.url), { recursive: true });
  await writeFile(target, output);
}
