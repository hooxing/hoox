import { ArrowUpRight, Check, LoaderCircle, Pause, Play, RotateCcw } from "lucide-react";
import { bookArtifacts, bookMessages } from "./landing-case.js";
import { useBookPlayback } from "./landing-playback.js";
import { InlineArtifactDelivery, RunStatusBadge, ThreadTranscript } from "./workspace-view.js";
import "./landing-book-case.css";

const ignoreAction = () => undefined;

export function BookCase() {
  const playback = useBookPlayback();
  return (
    <section
      className="landing-case"
      id="workbench"
      aria-labelledby="case-title"
      ref={playback.targetRef}
      data-motion={playback.motionState}
      data-playback={playback.paused ? "paused" : playback.finished ? "completed" : "running"}
    >
      <div className="landing-case-bar">
        <span>
          <span className="landing-dot" /> 真实任务
        </span>
        <span>执行回放</span>
      </div>
      <div className="landing-case-grid">
        <section className="landing-workspace" aria-label="国富论任务展示">
          <header className="landing-workspace-header">
            <h3 id="case-title">帮我整理一份思维导图</h3>
            {playback.paused && !playback.finished ? (
              <span className="landing-playback-paused">回放已暂停</span>
            ) : (
              <RunStatusBadge status={playback.run.status} />
            )}
          </header>
          <div className="landing-transcript">
            <ThreadTranscript
              messages={bookMessages}
              currentRun={playback.run}
              currentRunEvents={playback.events}
            />
            {playback.finished && (
              <InlineArtifactDelivery
                artifacts={bookArtifacts}
                readOnly
                onPreview={ignoreAction}
                onDownload={ignoreAction}
              />
            )}
          </div>
          <div className="landing-case-complete">
            <span className="landing-playback-status" role="status">
              {playback.finished ? (
                <Check size={15} aria-hidden="true" />
              ) : (
                <LoaderCircle
                  className={playback.paused ? undefined : "spin"}
                  size={15}
                  aria-hidden="true"
                />
              )}
              {playback.finished ? "交付完成" : playback.paused ? "已暂停" : "正在处理资料与文件"}
            </span>
            {playback.canAnimate && (
              <button
                type="button"
                className="landing-playback-control"
                onClick={playback.finished ? playback.replay : playback.togglePause}
              >
                {playback.finished ? (
                  <RotateCcw size={14} aria-hidden="true" />
                ) : playback.paused ? (
                  <Play size={14} aria-hidden="true" />
                ) : (
                  <Pause size={14} aria-hidden="true" />
                )}
                {playback.finished ? "再次回放" : playback.paused ? "继续回放" : "暂停回放"}
              </button>
            )}
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
