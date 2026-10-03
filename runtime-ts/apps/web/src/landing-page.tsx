import {
  ArrowDown,
  ArrowUpRight,
  Check,
  Code2,
  Files,
  GitBranch,
  Github,
  Layers3,
  Puzzle,
  ShieldCheck,
  Workflow,
} from "lucide-react";
import type { ReactNode } from "react";
import "@hoox/ui-theme/theme.css";
import "./styles.css";
import "./landing-page.css";
import { HOOX_HORIZONTAL_PATH } from "./brand.js";
import { bookArtifacts, bookMessages, bookRun } from "./landing-case.js";
import { InlineArtifactDelivery, RunStatusBadge, ThreadTranscript } from "./workspace-view.js";

const repository = "https://github.com/hooxing/hoox";
const capabilities = [
  {
    icon: Workflow,
    title: "不止一次对话，持续把事做完。",
    text: "连续上下文、持久执行与失败恢复，让长任务有进度、有记录，也能继续推进。",
    detail: "Thread · Run · Attempt",
    href: "/blob/main/docs/architecture/thread-continuity.md",
  },
  {
    icon: Files,
    title: "文件进来，成果出去。",
    text: "在工作区处理资料与文件，将中间资源和最终交付分开管理。任务结束，成果留在你手里。",
    detail: "Workspace · Resource · Artifact",
    href: "/blob/main/docs/architecture/overview.md",
  },
  {
    icon: GitBranch,
    title: "多 Agent，各司其职。",
    text: "主 Agent 拆解工作，子 Agent 独立处理子任务。隔离上下文，共享工作区，通过持久消息协作。",
    detail: "独立上下文 · 共享工作区 · Mailbox",
    href: "/blob/main/docs/architecture/agent-collaboration.md",
  },
  {
    icon: Puzzle,
    title: "把工作方法变成 Skills。",
    text: "安装、管理和版本化复用专业流程。每次运行固定技能快照，不因更新改变正在执行的任务。",
    detail: "Skills 不扩张工具或权限",
    href: "/blob/main/docs/architecture/skill-runtime.md",
  },
  {
    icon: Layers3,
    title: "从个人工作，到团队协作。",
    text: "个人与团队空间、任务分支、定时任务，让一次探索可以延续，也让重复工作按计划执行。",
    detail: "团队空间 · 任务分支 · 调度",
    href: "/blob/main/docs/architecture/team-collaboration.md",
  },
  {
    icon: ShieldCheck,
    title: "执行有边界，过程可追溯。",
    text: "沙箱执行、租户隔离与持久事件共同约束运行。源码、依赖与发布检查都在仓库中可查。",
    detail: "Tool Router · PostgreSQL RLS · 事件记录",
    href: "/blob/main/docs/architecture/overview.md",
  },
];

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
const ignoreAction = () => undefined;

function BookCase() {
  return (
    <section className="landing-case" id="workbench" aria-labelledby="case-title">
      <div className="landing-case-bar">
        <span>
          <span className="landing-dot" /> 真实任务
        </span>
        <span>阅读与整理</span>
      </div>
      <div className="landing-case-grid">
        <section className="landing-workspace" aria-label="国富论任务展示">
          <header className="landing-workspace-header">
            <h3 id="case-title">帮我整理一份思维导图</h3>
            <RunStatusBadge status="succeeded" />
          </header>
          <div className="landing-transcript">
            <ThreadTranscript messages={bookMessages} currentRun={bookRun} />
            <InlineArtifactDelivery
              artifacts={bookArtifacts}
              readOnly
              onPreview={ignoreAction}
              onDownload={ignoreAction}
            />
          </div>
          <div className="landing-case-complete">
            <Check size={15} aria-hidden="true" /> 读取资料、梳理结构、生成文件、交付成果
          </div>
        </section>
        <aside className="landing-case-note">
          <span className="landing-eyebrow">FROM REQUEST TO RESULT</span>
          <h2>
            交代一件事，
            <br />
            拿到一份成果。
          </h2>
          <p>一本《国富论》，一句需求。Hoox 阅读资料、梳理脉络，把结果整理成可以继续使用的文件。</p>
          <ol>
            <li>
              <span>01</span>
              <div>
                <strong>交代任务</strong>
                <p>直接说出需求，附上你的资料。</p>
              </div>
            </li>
            <li>
              <span>02</span>
              <div>
                <strong>看见执行</strong>
                <p>处理文件、调用工具，过程有迹可循。</p>
              </div>
            </li>
            <li>
              <span>03</span>
              <div>
                <strong>接着工作</strong>
                <p>拿走交付物，或在同一任务中继续完善。</p>
              </div>
            </li>
          </ol>
          <a href="/app" className="landing-text-link">
            把你的任务交给 Hoox <ArrowUpRight size={16} aria-hidden="true" />
          </a>
        </aside>
      </div>
    </section>
  );
}

export function LandingPage() {
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
          <a href="#capabilities">核心能力</a>
          <a href="#architecture">架构与部署</a>
          <RepositoryLink className="landing-nav-github">
            <Github size={17} aria-hidden="true" /> GitHub
          </RepositoryLink>
          <a className="landing-nav-app" href="/app">
            打开工作台 <ArrowUpRight size={15} aria-hidden="true" />
          </a>
        </nav>
      </header>
      <main id="main-content">
        <section className="landing-hero landing-wrap" aria-labelledby="hero-title">
          <p className="landing-eyebrow">
            <span className="landing-dot" /> 开源 Agent 工作台与执行运行时
          </p>
          <h1 id="hero-title">
            你说，<span>它做。</span>
          </h1>
          <p className="landing-hero-lead">一个能做事，也由你掌控的 Agent 工作空间。</p>
          <p className="landing-hero-copy">
            从对话、文件和工具执行，到真正可交付的成果。
            <br className="landing-desktop-break" />{" "}
            给日常工作一个帮手，也给开发者一套开放的执行底座。
          </p>
          <div className="landing-actions">
            <a className="landing-button landing-button-primary" href="/app">
              开始使用 Hoox <ArrowUpRight size={18} aria-hidden="true" />
            </a>
            <RepositoryLink className="landing-button">
              <Github size={18} aria-hidden="true" /> 查看源码
            </RepositoryLink>
          </div>
          <div className="landing-meta">
            <span>Apache-2.0</span>
            <span>TypeScript</span>
            <span>自主部署</span>
          </div>
          <a className="landing-discover" href="#workbench">
            看看它如何工作 <ArrowDown size={14} aria-hidden="true" />
          </a>
        </section>
        <div className="landing-wrap">
          <BookCase />
        </div>
        <section
          id="capabilities"
          className="landing-capabilities landing-wrap"
          aria-labelledby="capabilities-title"
        >
          <div className="landing-section-heading">
            <div>
              <p className="landing-eyebrow">BUILT TO GET THINGS DONE</p>
              <h2 id="capabilities-title">
                好用的工作台。
                <br />
                扎实的执行底座。
              </h2>
            </div>
            <p>
              使用者关心事情有没有做完。
              <br />
              开发者还关心：它是怎样做到的。
            </p>
          </div>
          <div className="landing-capability-grid">
            {capabilities.map(({ icon: Icon, title, text, detail, href }) => (
              <article key={title}>
                <div className="landing-capability-icon">
                  <Icon size={23} strokeWidth={1.6} aria-hidden="true" />
                </div>
                <h3>{title}</h3>
                <p>{text}</p>
                <RepositoryLink path={href} className="landing-capability-detail">
                  {detail}
                </RepositoryLink>
              </article>
            ))}
          </div>
        </section>
        <section
          id="architecture"
          className="landing-architecture"
          aria-labelledby="architecture-title"
        >
          <div className="landing-wrap landing-architecture-grid">
            <div>
              <p className="landing-eyebrow">OPEN BY DESIGN</p>
              <h2 id="architecture-title">
                你的模型。
                <br />
                你的基础设施。
                <br />
                <span>你的 Hoox。</span>
              </h2>
              <p className="landing-architecture-copy">
                不把运行机制藏在黑盒里。独立部署，阅读实现，按自己的需求构建。
              </p>
              <RepositoryLink
                path="/blob/main/docs/development.md"
                className="landing-button landing-button-light"
              >
                阅读部署文档
              </RepositoryLink>
              <p className="landing-deployment-note">
                部署需要 PostgreSQL、S3 兼容存储、Sandbox 与模型服务。
                <br />
                当前为 0.x 早期开发阶段。
              </p>
            </div>
            <section className="landing-stack" aria-label="Hoox 架构">
              <div className="landing-stack-client">
                <span>Web 工作台</span>
                <Code2 size={20} aria-hidden="true" />
                <span>API</span>
              </div>
              <div className="landing-stack-connector" aria-hidden="true">
                ↓
              </div>
              <div className="landing-stack-runtime">
                <span>HOOX RUNTIME</span>
                <strong>让执行连续、受控、可追溯</strong>
                <div>
                  <span>Agent Worker</span>
                  <span>Scheduler</span>
                  <span>Tool Router</span>
                </div>
              </div>
              <div className="landing-stack-connector" aria-hidden="true">
                ↓
              </div>
              <div className="landing-stack-foundation">
                <div>
                  <strong>模型服务</strong>
                  <span>按 Provider 契约接入</span>
                </div>
                <div>
                  <strong>Sandbox</strong>
                  <span>CubeSandbox / E2B / AGS</span>
                </div>
                <div>
                  <strong>持久化</strong>
                  <span>PostgreSQL / S3</span>
                </div>
              </div>
              <RepositoryLink
                path="/blob/main/docs/architecture/overview.md"
                className="landing-stack-link"
              >
                了解完整架构
              </RepositoryLink>
            </section>
          </div>
        </section>
        <section
          id="open-source"
          className="landing-open-source landing-wrap"
          aria-labelledby="opensource-title"
        >
          <p className="landing-eyebrow">BUILD IT TOGETHER</p>
          <h2 id="opensource-title">
            不只是使用。
            <br />
            也可以一起创造。
          </h2>
          <p>
            读代码，提建议，贡献一个修复，或分享你的工作方法。
            <br className="landing-desktop-break" />让 Agent 真正成为能够托付工作的工具。
          </p>
          <div className="landing-actions">
            <RepositoryLink className="landing-button landing-button-primary">
              前往 GitHub
            </RepositoryLink>
            <RepositoryLink path="/blob/main/CONTRIBUTING.md" className="landing-button">
              参与贡献
            </RepositoryLink>
          </div>
          <div className="landing-community-links">
            <RepositoryLink path="/issues">问题与建议</RepositoryLink>
            <RepositoryLink path="/blob/main/SECURITY.md">安全反馈</RepositoryLink>
            <RepositoryLink path="/blob/main/LICENSE">Apache-2.0 许可证</RepositoryLink>
          </div>
        </section>
      </main>
      <footer className="landing-footer landing-wrap">
        <a href="/" aria-label="返回 Hoox 首页">
          <img src={HOOX_HORIZONTAL_PATH} alt="Hoox" width="108" height="34" />
        </a>
        <span>你说，它做。</span>
        <div>
          <a href="/app">工作台</a>
          <RepositoryLink>GitHub</RepositoryLink>
        </div>
      </footer>
    </div>
  );
}
