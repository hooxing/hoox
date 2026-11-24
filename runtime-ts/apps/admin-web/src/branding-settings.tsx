import {
  BRAND_MODULES,
  DEFAULT_BRANDING,
  MAX_BRAND_LOGO_BYTES,
  normalizeBranding,
  validateBrandLogo,
  type BrandConfiguration,
  type SaveBrandingRequest,
} from "@hoox/protocol";
import { brandingTokens, useBranding } from "@hoox/ui-theme/branding";
import { useEffect, useRef, useState, type CSSProperties, type FormEvent } from "react";
import { AdminControlApi } from "./control-api.js";
import { HOOX_APP_ICON_PATH } from "./brand.js";

const defaultApi = new AdminControlApi();
type BrandingApi = Pick<AdminControlApi, "getBranding" | "saveBranding">;
const moduleLabels = {
  team_spaces: "团队空间",
  artifacts: "交付物面板",
  history_files: "历史文件与云盘",
  skills: "技能中心",
  automations: "定时任务",
};
export function BrandingSettings({ api = defaultApi }: { readonly api?: BrandingApi }) {
  const { update, defaultTokens } = useBranding();
  const [draft, setDraft] = useState<BrandConfiguration>(() => normalizeBranding(DEFAULT_BRANDING));
  const [generation, setGeneration] = useState<number>();
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");
  const [preview, setPreview] = useState<BrandConfiguration>();
  const pending = useRef<SaveBrandingRequest | undefined>(undefined);
  const linkIds = useRef<string[]>([]);
  useEffect(() => {
    let active = true;
    void api
      .getBranding()
      .then((value) => {
        if (!active) return;
        linkIds.current = value.configuration.footerLinks.map(() => crypto.randomUUID());
        setDraft(normalizeBranding(value.configuration));
        setGeneration(value.generation);
      })
      .catch(() => {
        if (active) setMessage("无法读取品牌设置，只有平台管理员可以管理品牌。请刷新后重试。");
      });
    return () => {
      active = false;
    };
  }, [api]);
  const validate = () => {
    try {
      const configuration = normalizeBranding(draft);
      setPreview(configuration);
      setMessage("");
      return configuration;
    } catch (reason) {
      setMessage(reason instanceof Error ? reason.message : "品牌设置无效");
      return undefined;
    }
  };
  const save = async (event: FormEvent) => {
    event.preventDefault();
    const configuration = validate();
    if (!configuration || generation === undefined || busy) return;
    const previous = pending.current;
    const request =
      previous &&
      previous.expectedGeneration === generation &&
      JSON.stringify(previous.configuration) === JSON.stringify(configuration)
        ? previous
        : { expectedGeneration: generation, requestId: crypto.randomUUID(), configuration };
    pending.current = request;
    setBusy(true);
    try {
      const result = await api.saveBranding(request);
      const saved = normalizeBranding(result.configuration);
      setDraft(saved);
      setGeneration(result.generation);
      update(saved);
      pending.current = undefined;
      setMessage("品牌设置已保存。其他页面刷新后生效。");
    } catch (reason) {
      setMessage(
        reason instanceof Error ? reason.message : "保存失败，请重试；若存在并发更新，请刷新页面。",
      );
    } finally {
      setBusy(false);
    }
  };
  const upload = async (file: File | undefined) => {
    if (!file) return;
    if (
      file.size > MAX_BRAND_LOGO_BYTES ||
      !["image/png", "image/jpeg", "image/webp"].includes(file.type)
    ) {
      setMessage("Logo 仅支持不超过 48 KiB 的 PNG、JPEG、WebP；不支持 SVG。");
      return;
    }
    try {
      const dataUrl = await new Promise<string>((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () =>
          typeof reader.result === "string"
            ? resolve(reader.result)
            : reject(new Error("LOGO_READ_FAILED"));
        reader.onerror = () => reject(new Error("LOGO_READ_FAILED"));
        reader.readAsDataURL(file);
      });
      validateBrandLogo(dataUrl);
      setDraft((current) => ({ ...current, logoDataUrl: dataUrl }));
      setMessage("");
    } catch {
      setMessage("Logo 读取失败或文件类型与内容不符。");
    }
  };
  return (
    <section className="branding-settings" aria-label="品牌设置">
      <h1>品牌设置</h1>
      <p>整个平台共用一份品牌设置，不按空间区分。隐藏模块只改变界面，不撤销后端权限。</p>
      {message && <p role="status">{message}</p>}
      <form onSubmit={(event) => void save(event)}>
        <fieldset disabled={busy || generation === undefined}>
          <label>
            产品名
            <input
              value={draft.productName}
              maxLength={60}
              required
              onChange={(event) => setDraft({ ...draft, productName: event.target.value })}
            />
          </label>
          <label>
            Logo（PNG / JPEG / WebP，最大 48 KiB）
            <input
              type="file"
              accept="image/png,image/jpeg,image/webp"
              onChange={(event) => void upload(event.target.files?.[0])}
            />
          </label>
          <button type="button" onClick={() => setDraft({ ...draft, logoDataUrl: null })}>
            使用默认 Logo
          </button>
          <label>
            主题主色
            <input
              aria-label="主题主色"
              placeholder="留空使用默认主色，如 #176b4d"
              value={draft.primaryColor ?? ""}
              maxLength={7}
              onChange={(event) => setDraft({ ...draft, primaryColor: event.target.value || null })}
            />
          </label>
          <p>仅接受 #RRGGBB；按钮前景色自动选择黑或白，保证可读对比度。</p>
          <h2>页脚链接（最多 5 个，仅 HTTPS / mailto）</h2>
          {draft.footerLinks
            .map((link, index) => ({ link, index, key: linkIds.current[index] }))
            .map(({ link, index, key }) => (
              <div className="branding-link-row" key={key}>
                <label>
                  链接文字 {index + 1}
                  <input
                    maxLength={60}
                    value={link.text}
                    onChange={(event) =>
                      setDraft({
                        ...draft,
                        footerLinks: draft.footerLinks.map((entry, ordinal) =>
                          ordinal === index ? { ...entry, text: event.target.value } : entry,
                        ),
                      })
                    }
                  />
                </label>
                <label>
                  链接地址 {index + 1}
                  <input
                    maxLength={2048}
                    value={link.url}
                    onChange={(event) =>
                      setDraft({
                        ...draft,
                        footerLinks: draft.footerLinks.map((entry, ordinal) =>
                          ordinal === index ? { ...entry, url: event.target.value } : entry,
                        ),
                      })
                    }
                  />
                </label>
                <button
                  type="button"
                  onClick={() => {
                    linkIds.current.splice(index, 1);
                    setDraft({
                      ...draft,
                      footerLinks: draft.footerLinks.filter((_entry, ordinal) => ordinal !== index),
                    });
                  }}
                >
                  删除链接 {index + 1}
                </button>
              </div>
            ))}
          <button
            type="button"
            disabled={draft.footerLinks.length >= 5}
            onClick={() => {
              linkIds.current.push(crypto.randomUUID());
              setDraft({ ...draft, footerLinks: [...draft.footerLinks, { text: "", url: "" }] });
            }}
          >
            添加页脚链接
          </button>
          <h2>隐藏工作台模块</h2>
          {BRAND_MODULES.map((module) => (
            <label key={module}>
              <input
                type="checkbox"
                checked={draft.hiddenModules.includes(module)}
                onChange={(event) =>
                  setDraft({
                    ...draft,
                    hiddenModules: event.target.checked
                      ? [...draft.hiddenModules, module]
                      : draft.hiddenModules.filter((entry) => entry !== module),
                  })
                }
              />
              {moduleLabels[module]}
            </label>
          ))}
          <div className="branding-actions">
            <button type="button" onClick={validate}>
              预览
            </button>
            <button
              type="button"
              onClick={() => {
                linkIds.current = [];
                setDraft(normalizeBranding(DEFAULT_BRANDING));
                setPreview(undefined);
                setMessage("已恢复默认草稿，保存后生效。");
              }}
            >
              恢复默认
            </button>
            <button type="submit">{busy ? "正在保存…" : "保存品牌设置"}</button>
          </div>
        </fieldset>
      </form>
      {preview && (
        <section
          className="branding-preview"
          aria-label="品牌预览"
          style={
            (preview.primaryColor === null
              ? defaultTokens
              : brandingTokens(preview.primaryColor)) as CSSProperties
          }
        >
          <img src={preview.logoDataUrl ?? HOOX_APP_ICON_PATH} alt="Logo 预览" />
          <h2>{preview.productName}</h2>
          <button type="button">主色按钮预览</button>
          <p>
            隐藏：{preview.hiddenModules.map((module) => moduleLabels[module]).join("、") || "无"}
          </p>
          {preview.footerLinks.map((link) => (
            <a
              key={`${link.text}:${link.url}`}
              href={link.url}
              target="_blank"
              rel="noopener noreferrer"
            >
              {link.text}
            </a>
          ))}
        </section>
      )}
    </section>
  );
}
