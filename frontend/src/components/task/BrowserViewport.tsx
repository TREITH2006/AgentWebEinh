/* =============================================================================
   BrowserViewport
   -----------------------------------------------------------------------------
   The live browser surface. Three honest states, and nothing else:

     1. A real frame arrives from the backend (`framesUrl` / `snapshotUrl`) and is
        rendered as an image. A freshness indicator shows how old it is.
     2. The backend has no frame route: a labelled placeholder explains what will
        appear here and still shows the page the agent *reported* it was on.
     3. Demo mode: explicitly marked as simulated, with no image at all.

   The container has a fixed aspect ratio so switching between these states, or
   receiving frames of any resolution, never reflows the page.
   ============================================================================= */

"use client";

import { useCallback, useEffect, useRef, useState } from "react";

import { useDataSource } from "@/lib/data-source";
import { withCacheBuster } from "@/lib/api/normalize";
import type { BrowserFrame, TaskRecord, TaskStatus } from "@/types/domain";
import { formatDuration, hostnameOf } from "@/lib/utils/format";
import { Badge } from "@/components/ui/StatusBadge";
import { GlobeIcon, MousePointerIcon } from "@/components/ui/icons";
import styles from "./BrowserViewport.module.css";

const SNAPSHOT_INTERVAL_MS = 1_200;

export interface BrowserViewportProps {
  task: TaskRecord | null;
  /** Task id used to resolve the frame endpoints once they exist. */
  taskId: string | null;
  running: boolean;
}

export function BrowserViewport({ task, taskId, running }: BrowserViewportProps): React.JSX.Element {
  const { service, isDemo } = useDataSource();
  const [frame, setFrame] = useState<BrowserFrame | null>(null);
  const [frameUrls, setFrameUrls] = useState<{ framesUrl: string | null; snapshotUrl: string | null }>({
    framesUrl: null,
    snapshotUrl: null,
  });
  const [frameError, setFrameError] = useState<string | null>(null);
  /* True once an image has actually decoded. The backend answers the snapshot
     route with 404 until the agent's first screenshot exists, and that is not a
     broken stream -- it is a task that has not reached the browser yet. Only a
     failure *after* a frame was decoded means the stream really died. */
  const [sawFrame, setSawFrame] = useState(false);
  const [now, setNow] = useState(() => Date.now());
  const probing = useRef<string | null>(null);

  /* Resolve the frame endpoints once per task. */
  useEffect(() => {
    if (isDemo || !taskId) {
      setFrameUrls({ framesUrl: null, snapshotUrl: null });
      setFrame(null);
      setSawFrame(false);
      return;
    }
    if (probing.current === taskId) return;
    probing.current = taskId;
    // A different task starts with no frame of its own.
    setSawFrame(false);

    const controller = new AbortController();
    void service.getTaskFrames(taskId, controller.signal).then(
      (result) => {
        if (controller.signal.aborted) return;
        setFrameUrls(result);
        setFrameError(null);
      },
      () => {
        if (controller.signal.aborted) return;
        setFrameUrls({ framesUrl: null, snapshotUrl: null });
      },
    );

    return () => controller.abort();
  }, [isDemo, service, taskId]);

  /* A stream URL is a long-lived image source: hand it to the browser once. */
  useEffect(() => {
    if (!frameUrls.framesUrl) return;
    setFrame({ kind: "image", src: frameUrls.framesUrl, at: new Date().toISOString(), label: "Live stream" });
    setFrameError(null);
  }, [frameUrls.framesUrl]);

  /* A snapshot URL is polled while the task runs. */
  useEffect(() => {
    if (!frameUrls.snapshotUrl) return;
    let cancelled = false;

    const capture = () => {
      if (cancelled) return;
      setFrame({
        kind: "image",
        src: withCacheBuster(frameUrls.snapshotUrl as string, Date.now()),
        at: new Date().toISOString(),
        label: "Latest frame",
      });
    };

    capture();
    if (!running) return;
    const timer = setInterval(capture, SNAPSHOT_INTERVAL_MS);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, [frameUrls.snapshotUrl, running]);

  /* Ticks once a second purely so the frame-age label stays accurate. */
  useEffect(() => {
    if (frame?.kind !== "image") return;
    const timer = setInterval(() => setNow(Date.now()), 1_000);
    return () => clearInterval(timer);
  }, [frame?.kind]);

  const handleImageLoad = useCallback(() => {
    setSawFrame(true);
    setFrameError(null);
  }, []);

  const handleImageError = useCallback(() => {
    // Before the first frame exists the snapshot route answers 404 on purpose.
    // Reporting that as a dead stream told the user their browser had crashed
    // while the agent was still working towards its first screenshot.
    if (!sawFrame) return;
    // Keep the last good frame on screen: the freshness badge already goes
    // "stale" after 5s, and blanking the image loses context for no gain.
    setFrameError("The frame stream stopped delivering images.");
  }, [sawFrame]);

  const status: TaskStatus = task?.status ?? "ready";
  const hasImage = frame?.kind === "image";
  /* The backend advertised a frame feed but has not decoded a frame yet. */
  const awaitingFirstFrame = !isDemo && !hasImage && !sawFrame && Boolean(frameUrls.snapshotUrl);
  const frameAge = frame?.kind === "image" ? Math.max(0, now - Date.parse(frame.at)) : null;
  const stale = typeof frameAge === "number" && frameAge > 5_000;

  return (
    <section className={styles.root} aria-labelledby="viewport-heading">
      <div className={styles.head}>
        <h3 className={styles.title} id="viewport-heading">
          Browser activity
        </h3>
        <div className={styles.headMeta}>
          {hasImage ? (
            <Badge tone={stale ? "warning" : "success"}>
              {stale ? "Frame stale" : "Live frame"} · {formatDuration(frameAge)}
            </Badge>
          ) : null}
          {!hasImage && !isDemo ? (
            <Badge tone={awaitingFirstFrame ? "idle" : "warning"}>
              {awaitingFirstFrame ? "Starting browser" : "No stream"}
            </Badge>
          ) : null}
          {isDemo ? <Badge tone="warning">Simulated</Badge> : null}
        </div>
      </div>

      <div className={styles.chrome} aria-hidden="true">
        <span className={styles.dots}>
          <span className={styles.dot} />
          <span className={styles.dot} />
          <span className={styles.dot} />
        </span>
        <span className={styles.urlBar}>
          <GlobeIcon size={12} />
          {task?.currentUrl ? hostnameOf(task.currentUrl) ?? task.currentUrl : "about:blank"}
        </span>
      </div>

      <div className={styles.stage} data-has-image={hasImage || undefined}>
        {hasImage && frame.kind === "image" ? (
          // A plain <img> keeps this dependency-free and works for both MJPEG
          // and polled-JPEG transports.
          // eslint-disable-next-line @next/next/no-img-element
          <img className={styles.frame} src={frame.src} alt={`Current browser view${task?.currentTitle ? `: ${task.currentTitle}` : ""}`} onLoad={handleImageLoad} onError={handleImageError} />
        ) : null}

        {!hasImage ? (
          <div className={styles.placeholder} data-variant={isDemo ? "demo" : "none"}>
            {isDemo ? (
              <>
                <span className={styles.placeholderIcon}>
                  <MousePointerIcon size={22} />
                </span>
                <p className={styles.placeholderTitle}>Simulated session</p>
                <p className={styles.placeholderBody}>
                  Demo mode scripts the event stream but never opens a real browser, so there is no screen to show.
                  Connect the backend to receive live frames here.
                </p>
              </>
            ) : (
              <>
                <span className={styles.placeholderIcon}>
                  <MousePointerIcon size={22} />
                </span>
                <p className={styles.placeholderTitle}>
                  {awaitingFirstFrame ? "Waiting for the first frame" : "No live browser stream"}
                </p>
                <p className={styles.placeholderBody}>
                  {awaitingFirstFrame
                    ? "This task is queued behind another one, or the agent has not opened a page yet. The browser view appears the moment the first screenshot is captured."
                    : "This backend does not expose a frame feed yet. The agent still reports each page it opens below, so you can follow its progress without the visual."}
                </p>
              </>
            )}
          </div>
        ) : null}

        {frameError ? (
          <p className={styles.frameError} role="alert">
            {frameError}
          </p>
        ) : null}

        {isDemo && hasImage ? (
          <span className={styles.watermark} aria-hidden="true">
            SIMULATED
          </span>
        ) : null}
      </div>

      <dl className={styles.meta}>
        <div className={styles.metaItem}>
          <dt>Page</dt>
          <dd title={task?.currentTitle ?? undefined}>{task?.currentTitle ?? "—"}</dd>
        </div>
        <div className={styles.metaItem}>
          <dt>URL</dt>
          <dd>
            {task?.currentUrl ? (
              <a href={task.currentUrl} target="_blank" rel="noopener noreferrer" className={styles.link}>
                {task.currentUrl}
              </a>
            ) : (
              "—"
            )}
          </dd>
        </div>
        <div className={styles.metaItem}>
          <dt>Status</dt>
          <dd>{status === "ready" ? "Idle" : status.replace(/_/g, " ")}</dd>
        </div>
      </dl>
    </section>
  );
}