import {
  ArrowDown,
  ArrowRight,
  ArrowUpRight,
  Box,
  Brain,
  Check,
  Code2,
  Database,
  FileCheck2,
  Files,
  GitBranch,
  Github,
  History,
  Layers3,
  LockKeyhole,
  MessageSquare,
  Pause,
  Play,
  Power,
  Puzzle,
  Radio,
  RotateCcw,
  ScanLine,
  ShieldCheck,
  Sparkles,
  Users,
  Workflow,
} from "lucide-react";
import { type CSSProperties, type ReactNode, useState } from "react";
import "@hoox/ui-theme/theme.css";
import "./styles.css";
import "./landing-page.css";
import { HOOX_HORIZONTAL_PATH } from "./brand.js";
import { BookCase } from "./landing-book-case.js";
import { useLandingClock } from "./landing-motion.js";

const repository = "https://github.com/hooxing/hoox";
type SceneClock = ReturnType<typeof useLandingClock>;

function RepositoryLink({
  path = "",
  children,
  className,
}: {
  readonly path?: string;
  readonly children: ReactNode;
  readonly className?: string;
}) {
  return (
    <a href={repository + path} className={className} target="_blank" rel="noopener noreferrer">
      {children}
      <ArrowUpRight size={16} aria-hidden="true" />
    </a>
  );
}

function SceneControls({ clock, name }: { readonly clock: SceneClock; readonly name: string }) {
  if (!clock.canAnimate) return null;
  return (
    <div className="landing-scene-controls">
      {!clock.finished && (
        <button
          type="button"
          onClick={clock.togglePause}
          aria-label={`${clock.paused ? "继续" : "暂停"}${name}动效`}
        >
          {clock.paused ? (
            <Play size={14} aria-hidden="true" />
          ) : (
            <Pause size={14} aria-hidden="true" />
          )}
        </button>
      )}
      <button type="button" onClick={clock.replay} aria-label={`重播${name}演示`}>
        <RotateCcw size={14} aria-hidden="true" />
        <span>重播</span>
      </button>
    </div>
  );
}

function SectionHeading({
  index,
  label,
  title,
  children,
}: {
  readonly index: string;
  readonly label: string;
  readonly title: ReactNode;
  readonly children: ReactNode;
}) {
  return (
    <div className="landing-section-heading">
      <div>
        <p className="landing-eyebrow">
          <span>{index}</span> / {label}
        </p>
        <h2>{title}</h2>
      </div>
      <div className="landing-heading-copy">{children}</div>
    </div>
  );
}

function RuntimeHero() {
  const clock = useLandingClock(4_800);
  const phase = Math.min(4, Math.floor(clock.elapsed / 960));
  const statuses = [
    "接收任务与资料",
    "准备模型与上下文",
    "调用沙箱与专业能力",
    "整理任务成果",
    "成果就绪，可以接着工作",
  ];
  return (
    <section
      className="landing-hero landing-wrap"
      aria-labelledby="hero-title"
      ref={clock.targetRef}
      data-motion={clock.motionState}
    >
      <div className="landing-hero-copy">
        <p className="landing-eyebrow">
          <span className="landing-dot" /> 开源、可自托管的云端 Agent 平台
        </p>
        <h1 id="hero-title">
          写好指令，接上工具，
          <br />
          <span className="landing-title-accent">就是你自己的 Agent。</span>
        </h1>
        <p className="landing-hero-lead">
          Agent 在云端沙箱里读文件、跑代码，
          <br />
          把成果文件交付给你和你的团队。
        </p>
        <p className="landing-hero-description">
          今天已可用：沙箱执行、文件交付、Skill 中心与团队协作。
          <br className="landing-desktop-break" />
          自定义 Agent、外部工具与 API 即将推出，见下方路线图。
        </p>
        <div className="landing-actions">
          <a className="landing-button landing-button-primary" href="/app">
            体验工作台 <ArrowUpRight size={18} aria-hidden="true" />
          </a>
          <RepositoryLink className="landing-button">
            <Github size={18} aria-hidden="true" />
            查看源码
          </RepositoryLink>
        </div>
        <div className="landing-meta">
          <span>Apache-2.0</span>
          <span>TypeScript</span>
          <span>自主部署</span>
        </div>
        <a href="#proof" className="landing-discover">
          看一个真实任务 <ArrowDown size={14} aria-hidden="true" />
        </a>
      </div>
      <div
        className="landing-runtime-art"
        onPointerMove={(event) => {
          if (!clock.canAnimate || event.pointerType !== "mouse") return;
          const rect = event.currentTarget.getBoundingClientRect();
          event.currentTarget.style.setProperty(
            "--tilt-x",
            `${(0.5 - (event.clientY - rect.top) / rect.height) * 6}deg`,
          );
          event.currentTarget.style.setProperty(
            "--tilt-y",
            `${((event.clientX - rect.left) / rect.width - 0.5) * 6}deg`,
          );
        }}
        onPointerLeave={(event) => {
          event.currentTarget.style.setProperty("--tilt-x", "0deg");
          event.currentTarget.style.setProperty("--tilt-y", "0deg");
        }}
      >
        <div className="landing-art-chrome">
          <span>
            <Radio size={12} aria-hidden="true" /> HOOX / 云端 AGENT
          </span>
          <span>机制演示</span>
        </div>
        <div key={clock.revision} className="landing-runtime-stage" data-phase={phase}>
          <div className="landing-stage-grid" aria-hidden="true" />
          <svg
            className="landing-circuit"
            viewBox="0 0 600 500"
            preserveAspectRatio="none"
            aria-hidden="true"
          >
            <defs>
              <filter id="landing-beam-glow">
                <feGaussianBlur stdDeviation="3" />
              </filter>
            </defs>
            {[
              "M300 78 V172",
              "M500 136 H420 Q400 136 400 156 V190 H360",
              "M300 250 V290 H115 Q100 290 100 310 V342",
              "M300 250 V342",
              "M300 250 V290 H485 Q500 290 500 310 V342",
              "M100 390 V414 H300 V438",
              "M300 390 V438",
              "M500 390 V414 H300 V438",
            ].map((path, index) => (
              <g key={path}>
                <path className="landing-circuit-base" d={path} />
                <path className={`landing-beam landing-beam-${index}`} d={path} pathLength="100" />
                <path
                  className={`landing-beam landing-beam-glow landing-beam-${index}`}
                  d={path}
                  pathLength="100"
                  filter="url(#landing-beam-glow)"
                />
              </g>
            ))}
          </svg>
          <div className="landing-hero-request">
            <MessageSquare size={16} aria-hidden="true" />
            <span>把资料整理成一份调研报告</span>
            <span>↵</span>
          </div>
          <div className="landing-model-node">
            <Sparkles size={14} aria-hidden="true" />
            模型服务
          </div>
          <div className="landing-runtime-core">
            <div className="landing-core-halo" aria-hidden="true" />
            <div className="landing-core-chip">
              <span className="landing-core-wordmark">
                Hoox<span>CLOUD</span>
              </span>
              <span className="landing-core-caption">SANDBOX · SKILLS · FILES</span>
              <div className="landing-core-pins" aria-hidden="true">
                {"abcdefghijkl".split("").map((pin) => (
                  <span key={pin} />
                ))}
              </div>
            </div>
          </div>
          <div className="landing-hero-tools">
            {[
              { icon: Box, label: "Sandbox" },
              { icon: Puzzle, label: "Skills" },
              { icon: Brain, label: "Memory", optional: true },
            ].map(({ icon: Icon, label, optional }) => (
              <div key={label} className={phase >= 2 ? "is-ready" : ""}>
                <Icon size={20} aria-hidden="true" />
                <span>
                  {label}
                  {optional && <small>可选</small>}
                </span>
              </div>
            ))}
          </div>
          <div className={`landing-hero-delivery ${phase >= 4 ? "is-delivered" : ""}`}>
            <FileCheck2 size={20} aria-hidden="true" />
            <div>
              <strong>调研报告.md</strong>
              <span>文件交付 · 可继续完善</span>
            </div>
            <Check size={16} aria-hidden="true" />
          </div>
        </div>
        <div className="landing-art-footer">
          <span className="landing-art-status" role="status">
            <span className="landing-dot" />
            {statuses[phase]}
          </span>
          <SceneControls clock={clock} name="执行链路" />
        </div>
      </div>
    </section>
  );
}

function ExecutionSection() {
  const [mode, setMode] = useState<"native" | "ptc">("ptc");
  const clock = useLandingClock(4_000);
  const step = Math.min(3, Math.floor(clock.elapsed / 1_000));
  const ptc = mode === "ptc";
  const lines = ptc
    ? [
        { id: "brief-call", text: "const brief = await tools.read({" },
        { id: "brief-path", text: '  path: "brief.md"' },
        { id: "brief-end", text: "});" },
        { id: "data-call", text: "const data = await tools.read({" },
        { id: "data-path", text: '  path: "data.csv"' },
        { id: "data-end", text: "});" },
        { id: "result", text: "return { brief, data };" },
      ]
    : [
        { id: "brief-call", text: "模型请求  →  读取 brief.md" },
        { id: "brief-result", text: "工具回执  ←  返回资料内容" },
        { id: "brief-end", text: " " },
        { id: "data-call", text: "模型请求  →  读取 data.csv" },
        { id: "data-result", text: "工具回执  ←  返回数据内容" },
        { id: "data-end", text: " " },
        { id: "result", text: "模型继续  →  整理报告" },
      ];
  return (
    <section
      id="execution"
      className="landing-section landing-wrap"
      ref={clock.targetRef}
      data-motion={clock.motionState}
      aria-labelledby="execution-title"
    >
      <SectionHeading
        index="02"
        label="执行方式"
        title={
          <span id="execution-title">
            同一个任务，
            <br />
            选择合适的执行方式。
          </span>
        }
      >
        <p>
          原生工具调用与程序化编排。
          <br />
          按模型能力和任务需要选择。
        </p>
        <RepositoryLink
          path="/blob/main/docs/architecture/tool-calling-modes.md"
          className="landing-text-link"
        >
          阅读执行契约
        </RepositoryLink>
      </SectionHeading>
      <div className="landing-execution-panel">
        <div className="landing-panel-bar">
          <fieldset className="landing-mode-picker" aria-label="工具调用模式演示">
            {(["native", "ptc"] as const).map((value) => (
              <button
                key={value}
                type="button"
                aria-pressed={mode === value}
                onClick={() => {
                  setMode(value);
                  clock.replay();
                }}
              >
                {value === "ptc" ? (
                  <>
                    程序化编排 <span>PTC · 实验</span>
                  </>
                ) : (
                  "原生工具调用"
                )}
              </button>
            ))}
          </fieldset>
          <SceneControls clock={clock} name="工具编排" />
        </div>
        <div
          key={`${mode}-${clock.revision}`}
          className="landing-execution-body"
          data-step={step}
          data-mode={mode}
        >
          <div className="landing-code-panel">
            <div className="landing-code-title">
              <span>{ptc ? "program.js" : "tool turns"}</span>
              <span>结构示意</span>
            </div>
            <pre>
              <code>
                {lines.map((line, index) => (
                  <span
                    key={`${mode}-${line.id}`}
                    className={
                      (step === 0 && index < 3) ||
                      (step === 1 && index >= 3 && index < 6) ||
                      (step >= 2 && index === 6)
                        ? "is-active"
                        : ""
                    }
                  >
                    <small>{String(index + 1).padStart(2, "0")}</small>
                    {line.text}
                  </span>
                ))}
              </code>
            </pre>
            <div className="landing-code-result">
              <Check size={14} aria-hidden="true" />
              {step >= 3 ? "所需结果已返回，模型继续整理报告" : "工具在隔离沙箱中执行"}
            </div>
          </div>
          <div className="landing-execution-visual">
            <span className="landing-overline">
              {ptc ? "PROGRAMMATIC TOOL CALLING" : "NATIVE TOOL CALLING"}
            </span>
            <h3>{ptc ? "连续工具操作，\n在程序内组织。" : "每一步，\n由模型直接决定。"}</h3>
            <div className="landing-call-chain">
              <div className={step >= 0 ? "is-active" : ""}>
                <Sparkles size={18} aria-hidden="true" />
                <span>模型规划</span>
                <small>{ptc ? "生成编排程序" : "发出工具请求"}</small>
              </div>
              <div className="landing-call-connector" aria-hidden="true">
                <span />
              </div>
              <div className={step >= 1 ? "is-active" : ""}>
                <Code2 size={18} aria-hidden="true" />
                <span>{ptc ? "读取资料 → 读取数据" : "工具回执 → 模型 → 下一工具"}</span>
                <small>{ptc ? "程序内依次调用" : "逐步交互"}</small>
              </div>
              <div className="landing-call-connector" aria-hidden="true">
                <span />
              </div>
              <div className={step >= 3 ? "is-active" : ""}>
                <FileCheck2 size={18} aria-hidden="true" />
                <span>模型整理报告</span>
                <small>继续完成任务</small>
              </div>
            </div>
            <p>
              {ptc
                ? "中间结果可在程序内处理，减少逐次返回模型的往返。当前内部工具串行执行，收益因模型与任务而异。"
                : "模型读取工具回执，再决定下一步。需要检查中间内容或依赖工具返回图片推理时，使用原生模式。"}
            </p>
          </div>
        </div>
      </div>
    </section>
  );
}

function ContinuitySection() {
  const [policy, setPolicy] = useState<"pause" | "kill">("pause");
  const clock = useLandingClock(4_800);
  const step = Math.min(3, Math.floor(clock.elapsed / 1_200));
  const steps = [
    "执行任务",
    "保存工作区",
    policy === "pause" ? "暂停实例" : "销毁实例",
    policy === "pause" ? "恢复执行" : "重建环境",
  ];
  return (
    <div className="landing-continuity-band">
      <section
        id="continuity"
        className="landing-section landing-wrap landing-split-section"
        ref={clock.targetRef}
        data-motion={clock.motionState}
      >
        <div className="landing-section-copy">
          <p className="landing-eyebrow">03 / 连续工作</p>
          <h2>
            执行可以暂停，
            <br />
            工作有据可续。
          </h2>
          <p>
            对话记忆与工作文件单独保存。
            <br />
            按任务需要选择实例复用或任务后销毁。
          </p>
          <div className="landing-feature-line">
            <History size={20} aria-hidden="true" />
            <div>
              <strong>上下文留得住</strong>
              <p>再次发消息时，Agent 记得之前聊过的内容。</p>
            </div>
          </div>
          <div className="landing-feature-line">
            <Files size={20} aria-hidden="true" />
            <div>
              <strong>工作区有版本</strong>
              <p>沙箱重建后，已保存的文件仍在。</p>
            </div>
          </div>
          <RepositoryLink
            path="/blob/main/docs/architecture/thread-continuity.md"
            className="landing-text-link"
          >
            了解连续上下文
          </RepositoryLink>
        </div>
        <div className="landing-lifecycle-panel">
          <div className="landing-panel-bar">
            <span className="landing-overline">SANDBOX LIFECYCLE</span>
            <SceneControls clock={clock} name="沙箱生命周期" />
          </div>
          <fieldset className="landing-policy-picker" aria-label="沙箱空闲策略演示">
            {(["pause", "kill"] as const).map((value) => (
              <button
                type="button"
                key={value}
                aria-pressed={policy === value}
                onClick={() => {
                  setPolicy(value);
                  clock.replay();
                }}
              >
                {value === "pause" ? (
                  <Pause size={14} aria-hidden="true" />
                ) : (
                  <Power size={14} aria-hidden="true" />
                )}
                {value === "pause" ? "暂停复用" : "任务后销毁"}
              </button>
            ))}
          </fieldset>
          <div
            key={`${policy}-${clock.revision}`}
            className="landing-sandbox-stage"
            data-step={step}
            data-policy={policy}
          >
            <div className="landing-sandbox-orbit landing-orbit-back" aria-hidden="true" />
            <div className="landing-sandbox-orbit landing-orbit-front" aria-hidden="true" />
            <div className="landing-sandbox-cube">
              <div className="landing-cube-top" />
              <div className="landing-cube-front">
                <Box size={24} aria-hidden="true" />
                <strong>{policy === "kill" && step === 3 ? "Sandbox B" : "Sandbox A"}</strong>
                <span>
                  {step === 2
                    ? policy === "pause"
                      ? "已暂停"
                      : "已销毁"
                    : step === 3
                      ? policy === "pause"
                        ? "已恢复"
                        : "新实例"
                      : "运行中"}
                </span>
              </div>
              <div className="landing-cube-side" />
            </div>
            <div className="landing-sandbox-shards" aria-hidden="true">
              {"abcdefgh".split("").map((shard, index) => (
                <span key={shard} style={{ "--shard": index } as CSSProperties} />
              ))}
            </div>
            <p className="landing-sandbox-state" role="status">
              {step === 2
                ? policy === "pause"
                  ? "保存状态，等待后续输入"
                  : "释放实例，保留已保存的工作"
                : step === 3
                  ? policy === "pause"
                    ? "恢复实例，接着处理后续任务"
                    : "新建实例，从已保存的文件接续"
                  : "对话与文件逐步保存"}
            </p>
          </div>
          <ol className="landing-lifecycle-steps">
            {steps.map((label, index) => (
              <li key={label} className={index <= step ? "is-active" : ""}>
                <span>{index < step ? <Check size={12} aria-hidden="true" /> : index + 1}</span>
                {label}
              </li>
            ))}
          </ol>
          <div className="landing-persistence-layer">
            <Database size={18} aria-hidden="true" />
            <div>
              <strong>对话记忆 + 工作文件版本</strong>
              <span>不随沙箱销毁而丢失</span>
            </div>
            <ShieldCheck size={18} aria-hidden="true" />
          </div>
        </div>
      </section>
    </div>
  );
}

function TeamSection() {
  const clock = useLandingClock(4_000);
  const step = Math.min(3, Math.floor(clock.elapsed / 1_000));
  return (
    <section
      id="team"
      className="landing-section landing-wrap"
      ref={clock.targetRef}
      data-motion={clock.motionState}
    >
      <SectionHeading
        index="04"
        label="团队工作台"
        title={
          <>
            从一个人的探索，
            <br />
            到团队继续推进。
          </>
        }
      >
        <p>
          对话生成团队分支，文件与 Skills
          <br />
          留在团队空间，记忆按空间隔离。
        </p>
        <RepositoryLink
          path="/blob/main/docs/architecture/team-collaboration.md"
          className="landing-text-link"
        >
          了解团队边界
        </RepositoryLink>
      </SectionHeading>
      <div className="landing-team-panel">
        <div className="landing-panel-bar">
          <span className="landing-panel-label">
            <GitBranch size={16} aria-hidden="true" /> 对话分支示意
          </span>
          <SceneControls clock={clock} name="团队分支" />
        </div>
        <div key={clock.revision} className="landing-team-stage" data-step={step}>
          <article className="landing-thread-card">
            <header>
              <span className="landing-avatar">
                <MessageSquare size={18} aria-hidden="true" />
              </span>
              <div>
                <strong>个人空间</strong>
                <p>供应商调研</p>
              </div>
              <LockKeyhole size={14} aria-label="个人空间" />
            </header>
            <div className="landing-chat-prompt">帮我整理供应商评估维度。</div>
            <div className="landing-chat-answer">
              <span>h</span>
              <p>从接入成本、运行能力与部署约束三个维度展开。</p>
            </div>
            <footer>
              <History size={14} aria-hidden="true" />
              来源对话保留
            </footer>
          </article>
          <div className="landing-branch-link" aria-hidden="true">
            <span className="landing-branch-wire" />
            <span className="landing-snapshot-packet">
              <Files size={20} />
            </span>
            <ArrowRight size={20} />
            <small>文本快照</small>
          </div>
          <article className="landing-thread-card landing-team-target">
            <header>
              <span className="landing-avatar landing-team-avatar">
                <Users size={18} aria-hidden="true" />
              </span>
              <div>
                <strong>工程团队</strong>
                <p>供应商调研 · 分支</p>
              </div>
              <span className="landing-team-tag">独立推进</span>
            </header>
            <div className="landing-shared-snapshot">
              <Check size={14} aria-hidden="true" />
              已带入来源对话文本
            </div>
            <div className="landing-team-message">
              <span className="landing-avatar">林</span>
              <p>接着评估各方案的部署成本。</p>
            </div>
            <footer>
              <GitBranch size={14} aria-hidden="true" />
              独立上下文与工作区
            </footer>
          </article>
        </div>
        <div className="landing-team-foundation">
          <span>
            <Brain size={16} aria-hidden="true" />
            团队记忆 · Mem0 可选接入
          </span>
          <span>
            <Puzzle size={16} aria-hidden="true" />
            团队文件与 Skills
          </span>
          <span>分支生成后各自推进，不双向同步</span>
        </div>
      </div>
      <div className="landing-team-details">
        <div>
          <Layers3 size={20} aria-hidden="true" />
          <h3>多 Agent，各司其职。</h3>
          <p>独立上下文，共享工作区，通过持久消息协作。</p>
          <RepositoryLink
            path="/blob/main/docs/architecture/agent-collaboration.md"
            className="landing-text-link"
          >
            智能体协作
          </RepositoryLink>
        </div>
        <div>
          <Puzzle size={20} aria-hidden="true" />
          <h3>把工作方法变成 Skills。</h3>
          <p>按空间管理和复用。Skills 不扩张工具或权限。</p>
          <RepositoryLink
            path="/blob/main/docs/architecture/skill-runtime.md"
            className="landing-text-link"
          >
            技能运行机制
          </RepositoryLink>
        </div>
      </div>
    </section>
  );
}

const sandboxProviders = ["CubeSandbox", "E2B", "腾讯云 AGS"] as const;
function IntegrationSection() {
  const [provider, setProvider] = useState<(typeof sandboxProviders)[number]>("CubeSandbox");
  const clock = useLandingClock(2_400);
  const providerIndex = sandboxProviders.indexOf(provider);
  const route = `M0 100 H35 Q45 100 45 ${[35, 100, 165][providerIndex]} H100`;
  return (
    <section
      id="providers"
      className="landing-section landing-wrap landing-integrations"
      ref={clock.targetRef}
      data-motion={clock.motionState}
    >
      <SectionHeading
        index="05"
        label="服务接入"
        title={
          <>
            模型与基础设施，
            <br />
            按你的需要接入。
          </>
        }
      >
        <p>
          在后台配置你选择的模型与沙箱，
          <br />
          不需要改代码。
        </p>
        <RepositoryLink
          path="/blob/main/docs/architecture/sandbox-providers.md"
          className="landing-text-link"
        >
          查看供应商能力
        </RepositoryLink>
      </SectionHeading>
      <div className="landing-integration-map">
        <div className="landing-service-inputs">
          <div>
            <Sparkles size={20} aria-hidden="true" />
            <div>
              <strong>模型服务</strong>
              <span>任意 OpenAI 兼容端点</span>
            </div>
          </div>
          <div>
            <Brain size={20} aria-hidden="true" />
            <div>
              <strong>长期记忆</strong>
              <span>Mem0 · 可选</span>
            </div>
          </div>
        </div>
        <span className="landing-map-incoming" aria-hidden="true" />
        <div className="landing-map-core">
          <span>Hoox</span>
          <small>统一调度与保存</small>
        </div>
        <svg
          className="landing-provider-route"
          viewBox="0 0 100 200"
          preserveAspectRatio="none"
          aria-hidden="true"
        >
          <path className="landing-route-base" d={route} />
          <path
            key={`${provider}-${clock.revision}`}
            className="landing-route-packet"
            d={route}
            pathLength="100"
          />
        </svg>
        <fieldset className="landing-provider-options" aria-label="沙箱供应商接入演示">
          {sandboxProviders.map((item, index) => (
            <button
              type="button"
              key={item}
              aria-pressed={provider === item}
              onClick={() => {
                setProvider(item);
                clock.replay();
              }}
            >
              <span className="landing-provider-mark">
                {index === 0 ? (
                  <Box size={20} aria-hidden="true" />
                ) : index === 1 ? (
                  <Code2 size={20} aria-hidden="true" />
                ) : (
                  <Layers3 size={20} aria-hidden="true" />
                )}
              </span>
              <span>{item}</span>
              {provider === item && <Check size={16} aria-label="已选择" />}
            </button>
          ))}
        </fieldset>
      </div>
      <div className="landing-integration-note">
        <span role="status">接入示意：{provider}</span>
        <p>新建的沙箱采用当前配置；已有沙箱继续使用原来的供应商，不会自动切换。</p>
      </div>
    </section>
  );
}

const traceEvents = [
  { title: "领取任务", detail: "任务排队后开始执行", icon: Workflow },
  { title: "准备上下文", detail: "载入对话历史与资料", icon: History },
  { title: "完成工具操作", detail: "每次工具调用都留下记录", icon: Code2 },
  { title: "发布交付物", detail: "调研报告.md 已就绪", icon: FileCheck2 },
] as const;
function OperationsSection() {
  const clock = useLandingClock(4_000);
  const step = Math.min(3, Math.floor(clock.elapsed / 1_000));
  return (
    <section
      id="architecture"
      className="landing-operations"
      ref={clock.targetRef}
      data-motion={clock.motionState}
    >
      <div className="landing-wrap landing-section">
        <SectionHeading
          index="06"
          label="部署与运维"
          title={
            <>
              发生了什么，
              <br />
              沿着记录看清楚。
            </>
          }
        >
          <p>
            查看任务进度、工具状态与交付结果。
            <br />
            模型配置和运行设置集中管理。
          </p>
          <RepositoryLink
            path="/blob/main/docs/architecture/overview.md"
            className="landing-text-link"
          >
            了解完整架构
          </RepositoryLink>
        </SectionHeading>
        <div className="landing-console">
          <div className="landing-console-bar">
            <span>
              <span className="landing-dot" /> HOOX / EXECUTION TRACE
            </span>
            <span>机制演示</span>
            <SceneControls clock={clock} name="运行轨迹" />
          </div>
          <div className="landing-console-body">
            <aside>
              <span className="landing-overline">运行记录</span>
              <strong>供应商调研报告</strong>
              <span className="landing-console-task-status">
                {clock.finished ? "交付完成" : "任务执行中"}
              </span>
              <hr />
              <span>
                <ScanLine size={16} aria-hidden="true" />
                执行轨迹
              </span>
              <span>
                <Sparkles size={16} aria-hidden="true" />
                模型配置
              </span>
              <span>
                <Workflow size={16} aria-hidden="true" />
                运行设置
              </span>
              <span>
                <ShieldCheck size={16} aria-hidden="true" />
                执行调度
              </span>
            </aside>
            <div key={clock.revision} className="landing-trace-list">
              {traceEvents.map(({ title, detail, icon: Icon }, index) => (
                <div
                  key={title}
                  className={`landing-trace-event ${index <= step ? "is-recorded" : ""} ${index === step && !clock.finished ? "is-current" : ""}`}
                >
                  <span className="landing-trace-index">0{index + 1}</span>
                  <span className="landing-trace-dot" />
                  <Icon size={20} aria-hidden="true" />
                  <div>
                    <strong>{title}</strong>
                    <p>{detail}</p>
                  </div>
                  <Check size={16} className="landing-trace-check" aria-hidden="true" />
                </div>
              ))}
            </div>
          </div>
          <div className="landing-console-footer">
            <span role="status">
              {clock.finished ? "执行完成，每一步都有记录" : "沿时间线查看执行过程"}
            </span>
            <span>示意内容，不读取用户任务</span>
          </div>
        </div>
        <div className="landing-deployment-row">
          <div>
            <strong>在你的基础设施上运行。</strong>
            <p>部署需要 PostgreSQL、S3 兼容存储、沙箱服务与模型服务。</p>
          </div>
          <RepositoryLink
            path="/blob/main/docs/development.md"
            className="landing-button landing-button-light"
          >
            阅读部署文档
          </RepositoryLink>
        </div>
      </div>
    </section>
  );
}

const roadmapItems = [
  "后台定义多个 Agent：编辑指令、选择模型与 Skill",
  "不改代码接入外部工具（MCP / HTTP）",
  "Playground：发布前试跑与对比版本",
  "API Key 与公开 API：把 Hoox 嵌入你的产品",
  "评测：用样例集回归检查 Agent 质量",
] as const;
function RoadmapSection() {
  return (
    <section id="roadmap" className="landing-section landing-wrap landing-roadmap">
      <SectionHeading
        index="07"
        label="路线图"
        title={
          <>
            打造你自己的 Agent，
            <br />
            这些即将推出。
          </>
        }
      >
        <p>以下能力尚未发布，不在当前版本中。</p>
        <RepositoryLink
          path="/blob/main/docs/plans/20261119-custom-agent-platform.md"
          className="landing-text-link"
        >
          查看实施计划
        </RepositoryLink>
      </SectionHeading>
      <ul className="landing-roadmap-list">
        {roadmapItems.map((item) => (
          <li key={item}>
            <span className="landing-roadmap-tag">即将推出</span>
            {item}
          </li>
        ))}
      </ul>
      <p className="landing-roadmap-note">
        当前为 0.x
        早期开发阶段：公共接口可能变化，尚未完成生产环境验收。沙箱的暂停与恢复取决于所选供应商的能力与保留策略。
      </p>
    </section>
  );
}

function SectionLinks() {
  return (
    <>
      <a href="#proof">真实任务</a>
      <a href="#execution">执行方式</a>
      <a href="#team">团队协作</a>
      <a href="#architecture">部署</a>
      <RepositoryLink>
        <Github size={16} aria-hidden="true" />
        GitHub
      </RepositoryLink>
    </>
  );
}

export interface LandingLinks {
  readonly privacyUrl?: string | undefined;
  readonly termsUrl?: string | undefined;
}

export function LandingPage({ privacyUrl, termsUrl }: LandingLinks = {}) {
  return (
    <div className="landing-page">
      <a href="#main-content" className="landing-skip">
        跳转到主要内容
      </a>
      <header className="landing-nav landing-wrap">
        <a href="/" aria-label="Hoox 首页">
          <img src={HOOX_HORIZONTAL_PATH} alt="Hoox" width="136" height="42" />
        </a>
        <nav aria-label="首页导航">
          <div className="landing-nav-sections">
            <SectionLinks />
          </div>
          <details className="landing-nav-menu">
            <summary>菜单</summary>
            <div>
              <SectionLinks />
            </div>
          </details>
          <a href="/app" className="landing-nav-app">
            打开工作台 <ArrowUpRight size={16} aria-hidden="true" />
          </a>
        </nav>
      </header>
      <main id="main-content">
        <RuntimeHero />
        <div className="landing-principles landing-wrap">
          <span>
            <Workflow size={16} aria-hidden="true" />
            云端沙箱执行
          </span>
          <span>
            <History size={16} aria-hidden="true" />
            成果文件交付
          </span>
          <span>
            <ScanLine size={16} aria-hidden="true" />
            Skill 可复用
          </span>
          <span>
            <Users size={16} aria-hidden="true" />
            团队可接续
          </span>
        </div>
        <div id="proof" className="landing-section landing-wrap landing-proof">
          <div className="landing-proof-heading">
            <p className="landing-eyebrow">01 / 真实任务</p>
            <p>一本电子书，如何变成可预览、可下载的思维导图。</p>
          </div>
          <BookCase />
        </div>
        <ExecutionSection />
        <ContinuitySection />
        <TeamSection />
        <IntegrationSection />
        <OperationsSection />
        <RoadmapSection />
        <section className="landing-open-source landing-wrap" aria-labelledby="opensource-title">
          <p className="landing-eyebrow">OPEN SOURCE. YOUR CONTROL.</p>
          <h2 id="opensource-title">下一步，把你的 Agent 跑起来。</h2>
          <p>从源码了解 Hoox，按你的基础设施部署。</p>
          <div className="landing-actions">
            <a href="/app" className="landing-button landing-button-primary">
              体验工作台 <ArrowUpRight size={18} aria-hidden="true" />
            </a>
            <RepositoryLink path="/blob/main/docs/development.md" className="landing-button">
              阅读部署文档
            </RepositoryLink>
          </div>
          <div className="landing-community-links">
            <RepositoryLink path="/blob/main/CONTRIBUTING.md">参与贡献</RepositoryLink>
            <RepositoryLink path="/issues">问题与建议</RepositoryLink>
            <RepositoryLink path="/blob/main/SECURITY.md">安全反馈</RepositoryLink>
          </div>
        </section>
      </main>
      <footer className="landing-footer landing-wrap">
        <a href="/" aria-label="返回 Hoox 首页">
          <img src={HOOX_HORIZONTAL_PATH} alt="Hoox" width="108" height="34" />
        </a>
        <span>开源、可自托管的云端 Agent 平台</span>
        <nav aria-label="页脚导航">
          <a href="/app">工作台</a>
          <RepositoryLink path="/blob/main/docs/README.md">文档</RepositoryLink>
          <RepositoryLink path="/blob/main/CHANGELOG.md">变更记录</RepositoryLink>
          <RepositoryLink>GitHub</RepositoryLink>
          <RepositoryLink path="/issues">Issue</RepositoryLink>
          <RepositoryLink path="/blob/main/LICENSE">Apache-2.0</RepositoryLink>
          {privacyUrl && <a href={privacyUrl}>隐私</a>}
          {termsUrl && <a href={termsUrl}>条款</a>}
        </nav>
      </footer>
    </div>
  );
}
