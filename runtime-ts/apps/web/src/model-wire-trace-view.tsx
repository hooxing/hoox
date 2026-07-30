import { Download, Eye, LoaderCircle, ShieldAlert } from "lucide-react";
import { useMemo, useRef, useState } from "react";
import type { ModelWireTraceRecord } from "./api.js";

interface TraceTurnGroup {
  readonly attemptId: string;
  readonly modelTurn: number;
  readonly transports: readonly {
    readonly transportAttempt: number;
    readonly records: readonly ModelWireTraceRecord[];
  }[];
}

export function groupModelWireTraces(
  records: readonly ModelWireTraceRecord[],
): readonly TraceTurnGroup[] {
  const turns = new Map<string, ModelWireTraceRecord[]>();
  for (const record of records) {
    const key = `${record.attemptId}\u0000${record.modelTurn}`;
    const existing = turns.get(key) ?? [];
    existing.push(record);
    turns.set(key, existing);
  }
  return [...turns.values()]
    .map((turnRecords) => {
      const first = turnRecords[0];
      if (first === undefined) throw new Error("模型网络诊断分组为空");
      const transports = new Map<number, ModelWireTraceRecord[]>();
      for (const record of turnRecords) {
        const existing = transports.get(record.transportAttempt) ?? [];
        existing.push(record);
        transports.set(record.transportAttempt, existing);
      }
      return {
        attemptId: first.attemptId,
        modelTurn: first.modelTurn,
        transports: [...transports.entries()]
          .sort(([left], [right]) => left - right)
          .map(([transportAttempt, groupedRecords]) => ({
            transportAttempt,
            records: groupedRecords.sort((left, right) => left.part.localeCompare(right.part)),
          })),
      };
    })
    .sort((left, right) => {
      const byAttempt = left.attemptId.localeCompare(right.attemptId);
      return byAttempt === 0 ? left.modelTurn - right.modelTurn : byAttempt;
    });
}

function traceStatus(record: ModelWireTraceRecord): string {
  if (record.captureErrorCode === "BODY_UNREADABLE") return "正文不可读";
  if (record.captureErrorCode === "CAPTURE_UNAVAILABLE") return "采集不可用";
  if (record.captureStatus === "truncated") return "已截断";
  if (record.captureStatus === "aborted") return "采集中止";
  if (record.captureStatus === "failed") return "采集失败";
  if (record.httpStatus !== undefined && (record.httpStatus < 200 || record.httpStatus >= 300)) {
    return `HTTP ${record.httpStatus}（非 2xx）`;
  }
  if (record.persistenceStatus !== "stored") return `存储 ${record.persistenceStatus}`;
  return record.httpStatus === undefined ? "完整" : `HTTP ${record.httpStatus}`;
}

function partLabel(part: ModelWireTraceRecord["part"]): string {
  return part === "request" ? "最终请求体" : "原始响应正文";
}

type PreviewState =
  | { readonly status: "loading"; readonly record: ModelWireTraceRecord }
  | { readonly status: "error"; readonly record: ModelWireTraceRecord; readonly message: string }
  | { readonly status: "ready"; readonly record: ModelWireTraceRecord; readonly bytes: Uint8Array };

function downloadRawBytes(record: ModelWireTraceRecord, bytes: Uint8Array): void {
  const copy = Uint8Array.from(bytes);
  const url = URL.createObjectURL(new Blob([copy.buffer], { type: "application/octet-stream" }));
  const link = document.createElement("a");
  link.href = url;
  link.download = `model-turn-${record.modelTurn}-http-${record.transportAttempt}-${record.part}.bin`;
  link.rel = "noopener";
  link.click();
  URL.revokeObjectURL(url);
}

export function ModelWireTracePanel({
  records,
  hasMore,
  unavailable,
  onLoadBody,
  onLoadMore,
}: {
  readonly records: readonly ModelWireTraceRecord[];
  readonly hasMore: boolean;
  readonly unavailable: boolean;
  readonly onLoadBody: (record: ModelWireTraceRecord) => Promise<Uint8Array>;
  readonly onLoadMore: () => Promise<void>;
}) {
  const groups = useMemo(() => groupModelWireTraces(records), [records]);
  const [preview, setPreview] = useState<PreviewState | undefined>();
  const requestSequence = useRef(0);
  const [loadingMore, setLoadingMore] = useState(false);
  const [paginationError, setPaginationError] = useState<string | undefined>();

  const load = async (record: ModelWireTraceRecord) => {
    const sequence = ++requestSequence.current;
    setPreview({ status: "loading", record });
    try {
      const bytes = await onLoadBody(record);
      if (requestSequence.current === sequence) setPreview({ status: "ready", record, bytes });
    } catch (error) {
      if (requestSequence.current !== sequence) return;
      setPreview({
        status: "error",
        record,
        message: error instanceof Error ? error.message : "诊断正文不可用或已过期",
      });
    }
  };

  const loadMore = async () => {
    if (loadingMore) return;
    setLoadingMore(true);
    setPaginationError(undefined);
    try {
      await onLoadMore();
    } catch (error) {
      setPaginationError(error instanceof Error ? error.message : "加载后续诊断记录失败");
    } finally {
      setLoadingMore(false);
    }
  };

  return (
    <>
      <section className="activity-section model-wire-section" aria-labelledby="model-wire-title">
        <div className="section-heading">
          <div>
            <span className="eyebrow">网络诊断</span>
            <h2 id="model-wire-title">模型网络报文</h2>
          </div>
          <span className="count-badge">{records.length}</span>
        </div>
        {records.length === 0 ? (
          <p className="panel-empty">
            {unavailable
              ? "诊断索引暂不可用；运行活动与交付物不受影响。"
              : "采集未启用，或本次运行尚无模型网络报文。"}
          </p>
        ) : (
          <>
            <p className="diagnostic-warning">
              <ShieldAlert size={15} aria-hidden="true" />
              敏感诊断：正文可能包含 Prompt、工具参数及模型可见的工具回执。响应字节位于 Fetch
              解码后、SSE 解析前，不包含 TCP 分帧。请勿转发。
            </p>
            {hasMore && (
              <div className="diagnostic-pagination">
                <p className="diagnostic-overflow" role="status">
                  仍有后续记录，当前已显示 {records.length} 条。
                </p>
                <button
                  type="button"
                  className="quiet-button"
                  disabled={loadingMore}
                  onClick={() => void loadMore()}
                >
                  {loadingMore ? "正在加载…" : "加载更多"}
                </button>
              </div>
            )}
            {paginationError !== undefined && (
              <p className="model-wire-error" role="alert">
                {paginationError}
              </p>
            )}
            <div className="model-wire-groups">
              {groups.map((group) => (
                <section
                  className="model-wire-turn"
                  key={`${group.attemptId}-${group.modelTurn}`}
                  aria-label={`模型轮次 ${group.modelTurn}`}
                >
                  <header>
                    <strong>模型轮次 {group.modelTurn}</strong>
                    <small title={group.attemptId}>Attempt {group.attemptId}</small>
                  </header>
                  {group.transports.map((transport) => (
                    <div className="model-wire-transport" key={transport.transportAttempt}>
                      <span className="transport-label">
                        HTTP 尝试 {transport.transportAttempt}
                        {transport.transportAttempt > 0 ? " · 重试" : ""}
                      </span>
                      {transport.records.map((record) => (
                        <div
                          className={`model-wire-record is-${record.captureStatus}`}
                          key={record.part}
                        >
                          <div>
                            <strong>{partLabel(record.part)}</strong>
                            <small>
                              {traceStatus(record)} · {record.size ?? "未知"} 字节
                            </small>
                          </div>
                          <button
                            type="button"
                            className="icon-button"
                            aria-label={`查看模型轮次 ${record.modelTurn} HTTP 尝试 ${record.transportAttempt} ${partLabel(record.part)}`}
                            title={record.bodyAvailable ? "查看原始字节" : "正文不可用或已过期"}
                            disabled={!record.bodyAvailable}
                            onClick={() => void load(record)}
                          >
                            <Eye size={15} />
                          </button>
                        </div>
                      ))}
                    </div>
                  ))}
                </section>
              ))}
            </div>
          </>
        )}
      </section>
      {preview !== undefined && (
        <dialog className="model-wire-preview" open aria-label="模型网络报文原始正文">
          <header>
            <div>
              <strong>{partLabel(preview.record.part)}</strong>
              <small>
                模型轮次 {preview.record.modelTurn} · HTTP 尝试 {preview.record.transportAttempt}
              </small>
            </div>
            <button
              type="button"
              className="icon-button"
              onClick={() => {
                requestSequence.current += 1;
                setPreview(undefined);
              }}
            >
              关闭
            </button>
          </header>
          {preview.status === "loading" ? (
            <p className="model-wire-loading">
              <LoaderCircle className="spin" size={16} aria-hidden="true" /> 正在读取并校验原始字节…
            </p>
          ) : preview.status === "error" ? (
            <p className="model-wire-error" role="alert">
              {preview.message}
            </p>
          ) : (
            <>
              <div className="model-wire-preview-meta">
                <span>实际 {preview.bytes.byteLength} 字节</span>
                <span>SHA-256 {preview.record.sha256 ?? "不可用"}</span>
                <button
                  type="button"
                  className="quiet-button"
                  onClick={() => downloadRawBytes(preview.record, preview.bytes)}
                >
                  <Download size={14} /> 下载原始字节
                </button>
              </div>
              <p className="model-wire-text-note">
                下方仅为 UTF-8 诊断视图；不可解码字节会显示替代字符，下载文件保持所采集的 Fetch
                应用层正文字节不变。
              </p>
              <pre>{new TextDecoder("utf-8").decode(preview.bytes)}</pre>
            </>
          )}
        </dialog>
      )}
    </>
  );
}
