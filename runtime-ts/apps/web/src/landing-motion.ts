import { useEffect, useRef, useState } from "react";

export function useLandingClock(durationMs: number, tickMs = 80) {
  const targetRef = useRef<HTMLElement>(null);
  const [elapsed, setElapsed] = useState(durationMs);
  const [visible, setVisible] = useState(false);
  const [pageVisible, setPageVisible] = useState(!document.hidden);
  const [paused, setPaused] = useState(false);
  const [canAnimate, setCanAnimate] = useState(false);
  const [revision, setRevision] = useState(0);

  useEffect(() => {
    if (typeof window.matchMedia !== "function" || typeof IntersectionObserver === "undefined")
      return;
    const media = window.matchMedia("(prefers-reduced-motion: reduce)");
    const updateMotion = () => {
      setCanAnimate(!media.matches);
      setElapsed(media.matches ? durationMs : 0);
      setPaused(false);
      setRevision((value) => value + 1);
    };
    updateMotion();
    media.addEventListener("change", updateMotion);
    const observer = new IntersectionObserver(
      ([entry]) => setVisible(entry?.isIntersecting ?? false),
      { threshold: 0.25 },
    );
    if (targetRef.current !== null) observer.observe(targetRef.current);
    const updateVisibility = () => setPageVisible(!document.hidden);
    document.addEventListener("visibilitychange", updateVisibility);
    return () => {
      observer.disconnect();
      media.removeEventListener("change", updateMotion);
      document.removeEventListener("visibilitychange", updateVisibility);
    };
  }, [durationMs]);

  const finished = elapsed >= durationMs;
  const running = canAnimate && visible && pageVisible && !paused && !finished;
  useEffect(() => {
    if (!running) return;
    // 离屏、后台或人工暂停不消耗分镜时间；恢复后继续，不重放已展示的步骤。
    const timer = window.setInterval(
      () => setElapsed((value) => Math.min(value + tickMs, durationMs)),
      tickMs,
    );
    return () => window.clearInterval(timer);
  }, [running, tickMs, durationMs]);

  return {
    targetRef,
    elapsed,
    finished,
    running,
    paused,
    canAnimate,
    revision,
    motionState: finished ? "complete" : running ? "playing" : "paused",
    togglePause: () => setPaused((value) => !value),
    replay: () => {
      setElapsed(canAnimate ? 0 : durationMs);
      setPaused(false);
      setRevision((value) => value + 1);
    },
  } as const;
}
