import type { ComponentProps } from "react";
import { createRoot } from "react-dom/client";
import { App } from "../src/main.js";
import { persistAccountSession, developmentSession } from "../src/account-access.js";
import type { Artifact, Run, Thread } from "../src/api.js";

persistAccountSession(localStorage, developmentSession);
const date = "2026-09-08T00:00:00.000Z";
const thread: Thread = {
  id: "thread_preview",
  title: "交付文件预览验证",
  status: "active",
  createdAt: date,
  updatedAt: date,
};
const run: Run = {
  id: "run_preview",
  threadId: thread.id,
  status: "succeeded",
  createdAt: date,
  updatedAt: date,
};
const artifacts: Artifact[] = ["docx", "xlsx", "pptx", "pdf", "png", "txt", "md", "csv"].map(
  (extension) => ({
    id: `artifact_${extension}`,
    name: `sample.${extension}`,
    resourceVersionId: `version_${extension}`,
    status: "published",
    createdAt: date,
    updatedAt: date,
  }),
);
const api: NonNullable<ComponentProps<typeof App>["apiClient"]> = {
  listThreads: async () => [thread],
  listLatestRuns: async () => [run],
  getRun: async () => run,
  listArtifacts: async () => artifacts,
  listEvents: async () => ({ attemptId: undefined, items: [] }),
  listThreadContext: async () => [],
  createThread: async () => thread,
  createRun: async () => run,
  cancelRun: async () => run,
  archiveThread: async () => thread,
  downloadArtifact: async () => "/unused",
  previewArtifact: async () => ({ kind: "text", text: "兼容预览" }),
  readArtifactContent: async (source, signal) => {
    const response = await fetch(`/browser-tests/fixtures/${source.name}`, { signal });
    return response.arrayBuffer();
  },
  uploadResource: async (file) => ({
    resourceId: `resource_${crypto.randomUUID()}`,
    versionId: `version_${crypto.randomUUID()}`,
    name: file.name,
    mediaType: file.type,
    sizeBytes: file.size,
    path: "/resources/screenshot.png",
  }),
  submitThreadInput: async () => ({
    receiptId: crypto.randomUUID(),
    inputSequence: 1,
    requestedMode: "auto",
    disposition: "queued",
    createdAt: date,
    updatedAt: date,
  }),
};
const root = document.getElementById("preview-check");
if (root) createRoot(root).render(<App apiClient={api} />);
