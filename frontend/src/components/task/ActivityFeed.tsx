/* =============================================================================
   ActivityFeed
   -----------------------------------------------------------------------------
   Renders exactly the events the backend (or the demo simulator) emitted, in the
   order they arrived. Nothing is interpolated or invented: if the stream is
   silent the feed says so.

   New rows animate in; auto-scroll pauses on hover or when the user scrolls up,
   so reading history is never interrupted by incoming events.
   ============================================================================= */

"use client";

import { useCallback, useLayoutEffect, useRef, useState } from "react";

import { eventMeta } from "@/lib/status";
import type { AgentEvent } from "@/types/domain";
import { formatEventTime, formatRelative } from "@/lib/utils/format";
import { Badge } from "@/components/ui/StatusBadge";
import { EmptyState } from "@/components/ui/States";
import { WaveLoader } from "@/components/ui/WaveLoader";
import {
  ArrowLeftIcon,
  CheckIcon,
  CloseIcon,
  FlagIcon,
  GlobeIcon,
  LayersIcon,
  ListIcon,
  MousePointerIcon,
  SearchIcon,
  SparkIcon,
  StopIcon,
  TargetIcon,
} from "@/components/ui/icons";
import styles from "./ActivityFeed.module.css";

const GLYPHS = {
  task: ListIcon,
  agent: SparkIcon,
  browser: GlobeIcon,
  navigate: ArrowLeftIcon,
  inspect: SearchIcon,
  action: MousePointerIcon,
  collect: LayersIcon,
  approval: FlagIcon,
  done: CheckIcon,
  fail: CloseIcon,
  stop: StopIcon,
  log: TargetIcon,
} as const;

export interface ActivityFeedProps {
  events: AgentEvent[];
  /** True while waiting for the very first event. */
  waiting: boolean;
  /** Maximum rows rendered; older events stay accessible via the expander. */
  limit?: number;
}

export function ActivityFeed({ events, waiting, limit = 120 }: ActivityFeedProps): React.JSX.Element {
  const listRef = useRef<HTMLOListElement | null>(null);
  const [autoScroll, setAutoScroll] = useState(true);
  const [expanded, setExpanded] = useState(false);
  const [newestFirst, setNewestFirst] = useState(false);

  const ordered = newestFirst ? [...events].reverse() : events;
  const visible = expanded ? ordered : ordered.slice(-limit);
  const hiddenCount = Math.max(0, ordered.length - visible.length);

  /* Keep the newest row in view while auto-scroll is on. */
  useLayoutEffect(() => {
    if (!autoScroll) return;
    const node = listRef.current;
    if (!node) return;
    node.scrollTop = node.scrollHeight;
  }, [autoScroll, events.length, newestFirst]);

  const handleScroll = useCallback(() => {
    const node = listRef.current;
    if (!node) return;
    const atBottom = node.scrollHeight - node.scrollTop - node.clientHeight < 24;
    setAutoScroll(atBottom);
  }, []);

  return (
    <div className={styles.root}>
      <div className={styles.toolbar}>
        <h3 className={styles.title}>
          Live activity
          <span className={styles.count}>{events.length}</span>
        </h3>
        <div className={styles.controls}>
          {events.length > limit ? (
            <button type="button" className={styles.control} onClick={() => setExpanded((value) => !value)}>
              {expanded ? "Show recent only" : `Show all ${events.length}`}
            </button>
          ) : null}
          {events.length > 1 ? (
            <button type="button" className={styles.control} onClick={() => setNewestFirst((value) => !value)}>
              {newestFirst ? "Oldest first" : "Newest first"}
            </button>
          ) : null}
          {!autoScroll ? (
            <button type="button" className={`${styles.control} ${styles.resume}`} onClick={() => setAutoScroll(true)}>
              Follow live
            </button>
          ) : null}
        </div>
      </div>

      {events.length === 0 ? (
        waiting ? (
          <div className={styles.waiting}>
            <WaveLoader label="Waiting for the first event" size="md" />
            <p className={styles.waitingHint}>
              The workspace opens as soon as the agent reports activity.
            </p>
          </div>
        ) : (
          <EmptyState
            title="No activity yet"
            description="Events will appear here the moment the agent reports them."
          />
        )
      ) : (
        <>
          {hiddenCount > 0 && !expanded ? (
            <p className={styles.moreNote}>{hiddenCount} earlier events are hidden.</p>
          ) : null}
          <ol className={styles.list} ref={listRef} onScroll={handleScroll} tabIndex={0} aria-label="Task activity log">
            {visible.map((event, index) => (
              <EventRow key={event.id} event={event} index={index} />
            ))}
          </ol>
        </>
      )}
    </div>
  );
}

function EventRow({ event, index }: { event: AgentEvent; index: number }): React.JSX.Element {
  const [open, setOpen] = useState(false);
  const meta = eventMeta(event.type);
  const Glyph = GLYPHS[meta.glyph] ?? TargetIcon;
  const hasDetail = Boolean(event.detail || event.url || event.data);

  return (
    <li className={styles.row} data-tone={meta.tone} style={{ animationDelay: `${Math.min(index, 12) * 18}ms` }}>
      <span className={styles.rail} aria-hidden="true">
        <span className={styles.glyph}>
          <Glyph size={14} />
        </span>
      </span>

      <div className={styles.body}>
        <div className={styles.rowHead}>
          <span className={styles.type}>{meta.label}</span>
          {event.origin === "demo" ? <Badge tone="warning">Simulated</Badge> : null}
          <time className={styles.time} dateTime={event.at} title={formatRelative(event.at)}>
            {formatEventTime(event.at)}
          </time>
        </div>

        <p className={styles.message}>{event.message}</p>

        {hasDetail ? (
          <>
            <button type="button" className={styles.expand} onClick={() => setOpen((value) => !value)} aria-expanded={open}>
              {open ? "Hide detail" : "Show detail"}
            </button>
            {open ? (
              <div className={styles.detail}>
                {event.detail ? <p className={styles.detailText}>{event.detail}</p> : null}
                {event.url ? (
                  <p className={styles.detailUrl} title={event.url}>
                    {event.url}
                  </p>
                ) : null}
                {event.data ? (
                  <pre className={styles.detailJson}>{JSON.stringify(event.data, null, 2)}</pre>
                ) : null}
              </div>
            ) : null}
          </>
        ) : null}
      </div>
    </li>
  );
}