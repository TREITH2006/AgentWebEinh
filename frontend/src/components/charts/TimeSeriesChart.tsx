/* =============================================================================
   TimeSeriesChart
   -----------------------------------------------------------------------------
   Dependency-free SVG line/area chart. Gaps (null values) break the path instead
   of being interpolated, so a day with no completed tasks reads as absent rather
   than as zero.

   Animation: the stroke draws in once the chart scrolls into view, and redraws
   only when the data actually changes — never on a timer.
   ============================================================================= */

"use client";

import { useId, useMemo } from "react";

import { useElementSize, useInView } from "@/lib/hooks/useUtilities";
import styles from "./Charts.module.css";

export interface Series {
  key: string;
  label: string;
  color: string;
  values: (number | null)[];
  /** Renders a soft gradient fill under the line. */
  area?: boolean;
}

export interface TimeSeriesChartProps {
  labels: string[];
  series: Series[];
  height?: number;
  /** Formats the y-axis tick labels. */
  formatValue?: (value: number) => string;
  /** Fixed y-domain; otherwise derived from the data. */
  domain?: [number, number];
  /** Hides the y-axis gridlines for very compact charts. */
  compact?: boolean;
  /** Dots only appear on hover unless `showDots` is set. */
  showDots?: boolean;
}

const PAD_TOP = 14;
const PAD_BOTTOM = 24;
const PAD_LEFT_COMPACT = 6;
const PAD_LEFT = 44;

interface Point {
  x: number;
  y: number;
  value: number;
  index: number;
}

/** Polyline length, used to size the dash animation. */
function pathLength(points: Point[]): number {
  let total = 0;
  for (let i = 1; i < points.length; i += 1) {
    const previous = points[i - 1];
    const current = points[i];
    if (!previous || !current) continue;
    total += Math.hypot(current.x - previous.x, current.y - previous.y);
  }
  return Math.ceil(total) + 8;
}

function buildSegments(points: (Point | null)[]): Point[][] {
  const segments: Point[][] = [];
  let current: Point[] = [];
  for (const point of points) {
    if (point) current.push(point);
    else if (current.length) {
      segments.push(current);
      current = [];
    }
  }
  if (current.length) segments.push(current);
  return segments;
}

function niceTicks(max: number, count = 4): number[] {
  if (max <= 0) return [0];
  const rawStep = max / count;
  const magnitude = 10 ** Math.floor(Math.log10(rawStep));
  const normalised = rawStep / magnitude;
  const step = (normalised >= 5 ? 5 : normalised >= 2 ? 2 : 1) * magnitude;
  const ticks: number[] = [];
  for (let value = 0; value <= max + step * 0.001; value += step) ticks.push(value);
  return ticks;
}

export function TimeSeriesChart({
  labels,
  series,
  height = 220,
  formatValue = (value) => String(Math.round(value)),
  domain,
  compact = false,
  showDots = false,
}: TimeSeriesChartProps): React.JSX.Element {
  const gradientId = useId().replace(/:/g, "");
  const { ref, width } = useElementSize<HTMLDivElement>();
  const { ref: viewRef, inView } = useInView<HTMLDivElement>({ threshold: 0.2 });
  const measureRef = (node: HTMLDivElement | null) => {
    ref.current = node;
    viewRef.current = node;
  };

  const padLeft = compact ? PAD_LEFT_COMPACT : PAD_LEFT;
  const innerWidth = Math.max(0, width - padLeft - 12);
  const innerHeight = Math.max(0, height - PAD_TOP - PAD_BOTTOM);

  const { maxValue, ticks } = useMemo(() => {
    const values = series.flatMap((entry) => entry.values).filter((value): value is number => typeof value === "number");
    const highest = domain ? domain[1] : values.length ? Math.max(...values) : 1;
    const resolvedMax = domain ? domain[1] : highest <= 0 ? 1 : highest * 1.15;
    return { maxValue: resolvedMax, ticks: domain ? [domain[0], (domain[0] + domain[1]) / 2, domain[1]] : niceTicks(resolvedMax) };
  }, [series, domain]);

  const count = labels.length;
  const stepX = count > 1 ? innerWidth / (count - 1) : 0;
  const toY = (value: number) => PAD_TOP + innerHeight - (value / (maxValue || 1)) * innerHeight;

  const geometry = useMemo(
    () =>
      series.map((entry) => {
        const points: (Point | null)[] = entry.values.map((value, index) => {
          if (typeof value !== "number") return null;
          const x = padLeft + (count > 1 ? index * stepX : innerWidth / 2);
          return { x, y: toY(value), value, index };
        });
        return {
          entry,
          points,
          segments: buildSegments(points),
        };
      }),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [series, labels, innerWidth, innerHeight, maxValue, padLeft, stepX, count],
  );

  const showAxis = !compact && width > 220;
  // Label roughly six ticks along the x-axis to avoid crowding on narrow widths.
  const labelStride = count > 0 ? Math.max(1, Math.ceil(count / (width > 520 ? 8 : 4))) : 1;

  return (
    <div className={styles.chartWrap} ref={measureRef}>
      {width > 0 ? (
        <svg
          className={styles.svg}
          width={width}
          height={height}
          viewBox={`0 0 ${width} ${height}`}
          role="img"
          aria-label={`${series.map((entry) => entry.label).join(" and ")} over time`}
        >
          <defs>
            {series.map((entry) => (
              <linearGradient key={entry.key} id={`${gradientId}-${entry.key}`} x1="0" y1="0" x2="0" y2="1">
                <stop offset="0%" stopColor={entry.color} stopOpacity={0.34} />
                <stop offset="100%" stopColor={entry.color} stopOpacity={0} />
              </linearGradient>
            ))}
          </defs>

          {showAxis
            ? ticks.map((tick) => (
                <g key={tick}>
                  <line
                    x1={padLeft}
                    x2={padLeft + innerWidth}
                    y1={toY(tick)}
                    y2={toY(tick)}
                    stroke="rgba(177,173,255,0.12)"
                    strokeWidth={1}
                  />
                  <text className={styles.axisText} x={padLeft - 9} y={toY(tick) + 3.5} textAnchor="end">
                    {formatValue(tick)}
                  </text>
                </g>
              ))
            : null}

          {geometry.map(({ entry, points, segments }) => {
            const length = pathLength(points.flatMap((point) => (point ? [point] : [])));
            return (
              <g key={entry.key}>
                {entry.area
                  ? segments
                      .filter((segment) => segment.length > 1)
                      .map((segment, index) => {
                        const line = segment.map((point) => `${point.x},${point.y}`).join(" ");
                        const base = PAD_TOP + innerHeight;
                        const first = segment[0];
                        const last = segment[segment.length - 1];
                        if (!first || !last) return null;
                        return (
                          <polygon
                            key={`area-${index}`}
                            points={`${line} ${last.x},${base} ${first.x},${base}`}
                            fill={`url(#${gradientId}-${entry.key})`}
                            opacity={inView ? 1 : 0}
                            style={{ transition: "opacity 520ms cubic-bezier(0.22,1,0.36,1)" }}
                          />
                        );
                      })
                  : null}

                {segments.map((segment, index) => {
                  if (segment.length === 1) {
                    const only = segment[0];
                    if (!only) return null;
                    return <circle key={`dot-${index}`} cx={only.x} cy={only.y} r={2.6} fill={entry.color} />;
                  }
                  const line = segment.map((point) => `${point.x},${point.y}`).join(" ");
                  return (
                    <polyline
                      key={`line-${index}`}
                      className={inView ? "bw-anim-draw" : undefined}
                      style={{ "--bw-path-len": length } as React.CSSProperties}
                      points={line}
                      fill="none"
                      stroke={entry.color}
                      strokeWidth={2}
                      strokeLinecap="round"
                      strokeLinejoin="round"
                    />
                  );
                })}

                {showDots
                  ? points.map((point, index) =>
                      point ? <circle key={`p-${index}`} cx={point.x} cy={point.y} r={2.4} fill={entry.color} /> : null,
                    )
                  : null}
              </g>
            );
          })}

          {labels.map((label, index) => {
            if (index % labelStride !== 0 && index !== count - 1) return null;
            const x = padLeft + (count > 1 ? index * stepX : innerWidth / 2);
            return (
              <text
                key={`${label}-${index}`}
                className={styles.axisText}
                x={x}
                y={height - 7}
                textAnchor={index === 0 ? "start" : index === count - 1 ? "end" : "middle"}
              >
                {label}
              </text>
            );
          })}
        </svg>
      ) : (
        <div className={styles.chartPlaceholder} style={{ height }} />
      )}
    </div>
  );
}