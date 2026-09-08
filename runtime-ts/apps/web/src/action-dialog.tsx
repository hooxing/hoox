import { X } from "lucide-react";
import { useCallback, useEffect, useId, useRef, useState } from "react";
import { createPortal } from "react-dom";

interface DialogOptions {
  readonly title: string;
  readonly description?: string;
  readonly confirmLabel: string;
  readonly danger?: boolean;
  readonly field?: {
    readonly label: string;
    readonly initialValue: string;
    readonly choices?: readonly { readonly value: string; readonly label: string }[];
  };
}

/** 取消、替换请求和宿主卸载均返回 null，调用方不得继续提交操作。 */
export function useActionDialog() {
  const [options, setOptions] = useState<DialogOptions>();
  const resolver = useRef<((value: string | null) => void) | undefined>(undefined);
  const sequence = useRef(0);
  const ask = useCallback((next: DialogOptions) => {
    resolver.current?.(null);
    sequence.current += 1;
    setOptions(next);
    return new Promise<string | null>((resolve) => {
      resolver.current = resolve;
    });
  }, []);
  const finish = useCallback((value: string | null) => {
    const resolve = resolver.current;
    resolver.current = undefined;
    setOptions(undefined);
    resolve?.(value);
  }, []);
  useEffect(() => () => resolver.current?.(null), []);
  return {
    ask,
    dialog: options ? (
      <ActionDialog key={sequence.current} options={options} onFinish={finish} />
    ) : null,
  };
}

function ActionDialog({
  options,
  onFinish,
}: {
  readonly options: DialogOptions;
  readonly onFinish: (value: string | null) => void;
}) {
  const id = useId();
  const panel = useRef<HTMLDivElement>(null);
  const [value, setValue] = useState(options.field?.initialValue ?? "");
  const [error, setError] = useState(false);
  useEffect(() => {
    const element = panel.current;
    if (!element) return;
    const previous = document.activeElement;
    const overflow = document.body.style.overflow;
    // 二次确认挂到 body，屏蔽包括下层团队弹窗在内的背景交互。
    const siblings = Array.from(document.body.children).filter(
      (item): item is HTMLElement => item instanceof HTMLElement && item !== element.parentElement,
    );
    const inertStates = siblings.map((item) => item.inert);
    for (const item of siblings) item.inert = true;
    document.body.style.overflow = "hidden";
    const initial = element.querySelector<HTMLElement>("input, select, [data-cancel]");
    initial?.focus();
    if (initial instanceof HTMLInputElement) initial.select();
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        event.stopImmediatePropagation();
        onFinish(null);
      }
      if (event.key !== "Tab") return;
      const controls = Array.from(
        element.querySelectorAll<HTMLElement>("button:not(:disabled), input, select"),
      );
      const first = controls[0];
      const last = controls.at(-1);
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last?.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first?.focus();
      }
    };
    window.addEventListener("keydown", onKeyDown, true);
    return () => {
      window.removeEventListener("keydown", onKeyDown, true);
      siblings.forEach((item, index) => {
        item.inert = inertStates[index] ?? false;
      });
      document.body.style.overflow = overflow;
      if (previous instanceof HTMLElement && previous.isConnected) previous.focus();
    };
  }, [onFinish]);
  return createPortal(
    <div className="action-dialog-backdrop">
      <div
        ref={panel}
        className="action-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby={`${id}-title`}
        aria-describedby={options.description ? `${id}-description` : undefined}
      >
        <header>
          <h2 id={`${id}-title`}>{options.title}</h2>
          <button
            type="button"
            className="icon-button"
            aria-label="关闭弹窗"
            onClick={() => onFinish(null)}
          >
            <X size={20} />
          </button>
        </header>
        {options.description && <p id={`${id}-description`}>{options.description}</p>}
        <form
          noValidate
          onSubmit={(event) => {
            event.preventDefault();
            if (options.field && !value.trim()) {
              setError(true);
              return;
            }
            onFinish(options.field ? value.trim() : "confirmed");
          }}
        >
          {options.field && (
            <div className="action-dialog-field">
              <label htmlFor={`${id}-field`}>{options.field.label}</label>
              {options.field.choices ? (
                <select
                  id={`${id}-field`}
                  value={value}
                  onChange={(event) => setValue(event.target.value)}
                >
                  {options.field.choices.map((choice) => (
                    <option key={choice.value} value={choice.value}>
                      {choice.label}
                    </option>
                  ))}
                </select>
              ) : (
                <input
                  id={`${id}-field`}
                  value={value}
                  aria-invalid={error}
                  aria-describedby={error ? `${id}-error` : undefined}
                  onChange={(event) => {
                    setValue(event.target.value);
                    setError(false);
                  }}
                />
              )}
              {error && (
                <span id={`${id}-error`} role="alert">
                  {options.field.label}不能为空
                </span>
              )}
            </div>
          )}
          <footer>
            <button type="button" data-cancel onClick={() => onFinish(null)}>
              取消
            </button>
            <button
              type="submit"
              className={options.danger ? "action-dialog-danger" : "action-dialog-primary"}
            >
              {options.confirmLabel}
            </button>
          </footer>
        </form>
      </div>
    </div>,
    document.body,
  );
}
