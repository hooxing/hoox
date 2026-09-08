import { createContext, useContext, useMemo, useReducer } from "react";
import { FileText, X } from "lucide-react";
import {
  fileSelectionLabel,
  readFileReferences,
  type FileReference,
  type FileSource,
  type FileSelection,
} from "@hoox/protocol/file-references";

export type DraftFileReference = { id: string; reference: FileReference; snapshotDataUrl?: string };
export const FilePreviewContext = createContext<
  { open: (source: FileSource, selection?: FileSelection) => void } | undefined
>(undefined);

export function MessageFileReferences({ text }: { text: string }) {
  const context = useContext(FilePreviewContext);
  const parsed = readFileReferences(text);
  if (parsed.references.length === 0) return null;
  return (
    <ul className="file-reference-list" aria-label="引用的文件区域">
      {parsed.references.map((reference, index) => (
        // biome-ignore lint/suspicious/noArrayIndexKey: 已发送消息的引用顺序不可变，同一选区允许重复出现。
        <li key={`${index}:${reference.source.artifactId}`}>
          <button
            type="button"
            onClick={() => context?.open(reference.source, reference.selection)}
            disabled={context === undefined}
          >
            <strong>
              {index + 1}. {reference.source.name}
            </strong>
            <span>{fileSelectionLabel(reference.selection)}</span>
            {"quote" in reference.selection && <q>{reference.selection.quote.slice(0, 160)}</q>}
            <small>查看引用版本及位置</small>
          </button>
        </li>
      ))}
    </ul>
  );
}

export function DraftFileReferences({
  items,
  disabled,
  onRemove,
}: {
  items: readonly DraftFileReference[];
  disabled: boolean;
  onRemove: (id: string) => void;
}) {
  const context = useContext(FilePreviewContext);
  if (items.length === 0) return null;
  return (
    <ul className="file-reference-list is-draft" aria-label="待发送引用">
      {items.map((item, index) => (
        <li key={item.id}>
          <button
            type="button"
            className="reference-item-content"
            onClick={() => context?.open(item.reference.source, item.reference.selection)}
          >
            {item.snapshotDataUrl ? (
              <img src={item.snapshotDataUrl} alt="引用区域" />
            ) : (
              <FileText size={16} aria-hidden="true" />
            )}
            <strong title={item.reference.source.name}>{item.reference.source.name}</strong>
            <span
              className="reference-item-excerpt"
              title={
                "quote" in item.reference.selection
                  ? item.reference.selection.quote
                  : fileSelectionLabel(item.reference.selection)
              }
            >
              {"quote" in item.reference.selection
                ? item.reference.selection.quote.slice(0, 160)
                : fileSelectionLabel(item.reference.selection)}
            </span>
          </button>
          <button
            type="button"
            className="reference-remove"
            disabled={disabled}
            aria-label={`移除引用 ${index + 1}`}
            onClick={() => onRemove(item.id)}
          >
            <X size={14} aria-hidden="true" />
          </button>
        </li>
      ))}
    </ul>
  );
}

export function useFileReferenceDraft(
  userId: string,
  tenantId: string | undefined,
  threadId: string | undefined,
) {
  const cache = useMemo(
    () => ({
      userId,
      values: new Map<string, readonly DraftFileReference[]>(),
      failed: new Set<string>(),
    }),
    [userId],
  );
  const store = cache.values;
  const [, refresh] = useReducer((n: number) => n + 1, 0);
  const key = `hoox.conversation-draft.v1:${encodeURIComponent(userId)}:references:${JSON.stringify([tenantId ?? null, threadId ?? null])}`;
  if (!store.has(key)) {
    try {
      const raw: unknown = JSON.parse(sessionStorage.getItem(key) ?? "[]");
      const items = Array.isArray(raw)
        ? raw
            .filter(
              (item): item is DraftFileReference =>
                typeof item?.id === "string" &&
                readFileReferences(
                  `\n\n<hoox-file-references-v1>\n${JSON.stringify([item.reference])}\n</hoox-file-references-v1>`,
                ).references.length === 1 &&
                (item.snapshotDataUrl === undefined ||
                  (typeof item.snapshotDataUrl === "string" &&
                    /^data:image\/png;base64,[A-Za-z0-9+/=]+$/u.test(item.snapshotDataUrl))),
            )
            .slice(0, 8)
        : [];
      store.set(key, items);
    } catch {
      store.set(key, []);
      cache.failed.add(key);
    }
  }
  const items = store.get(key) ?? [];
  return {
    items,
    persistenceFailed: cache.failed.has(key),
    setItems(next: readonly DraftFileReference[]) {
      store.set(key, next);
      try {
        if (next.length === 0) sessionStorage.removeItem(key);
        else sessionStorage.setItem(key, JSON.stringify(next));
        cache.failed.delete(key);
      } catch {
        cache.failed.add(key);
      }
      refresh();
    },
  };
}
