/* =============================================================================
   BarChart
   -----------------------------------------------------------------------------
   Grouped bars with an optional stacked mode, used for completed vs failed per
   period. Bars grow from zero when the chart first appears and when the data
   changes, with a per-bar stagger.
   ============================================================================= */

"use client";

import { useMemo } from "react";

import { useElementSize, useInView } from "@/lib/hooks/useUtilities";
import styles from "./Charts.module.css";

export interface BarSeries {
  key: string;
  label: string;
  color: string;
  values: number[];
}

export interface BarChartProps {
  labels: string[];
  series: BarSeries[];
  height?: number;
  formatValue?: (value: number) => string;
  /** Renders values above each bar once growth finishes. */
  showValues?: boolean;
}

const PAD_TOP = 16;
const PAD_BOTTOM = 24;
const PAD_LEFT = 40;

export function BarChart({
  labels,
  series,
  height = 220,
  formatValue = (value) => String(Math.round(value)),
  showValues = false,
}: BarChartProps): React.JSX.Element {
  const { ref, width } = useElementSize<HTMLDivElement>();
  const { ref: viewRef, inView } = useInView<HTMLDivElement>({ threshold: 0.2 });
  const measureRef = (node: HTMLDivElement | null) => {
    ref.current = node;
    viewRef.current = node;
  };

  const innerWidth = Math.max(0, width - PAD_LEFT - 10);
  const innerHeight = Math.max(0, height - PAD_TOP - PAD_BOTTOM);
  const maxValue = useMemo(() => {
    const perGroup = labels.map((_, index) => series.reduce((sum, entry) => sum + (entry.values[index] ?? 0), 0));
    const highest = perGroup.length ? Math.max(...perGroup) : 0;
    return highest <= 0 ? 1 : highest;
  }, [labels, series]);

  const count = labels.length;
  const groupWidth = count > 0 ? innerWidth / count : 0;
  const barGap = 3;
  const barWidth = Math.max(3, (groupWidth - 14 - barGap * (series.length - 1)) / Math.max(1, series.length));
  const maxLabelStride = count > 0 ? Math.max(1, Math.ceil(count / (width > 520 ? 10 : 5))) : 1;

  return (
    <div className={styles.chartWrap} ref={measureRef}>
      {width > 0 ? (
        <svg
          className={styles.svg}
          width={width}
          height={height}
          viewBox={`0 0 ${width} ${height}`}
          role="img"
          aria-label={`${series.map((entry) => entry.label).join(" and ")} by period`}
        >
          {[0, 0.5, 1].map((fraction) => {
            const value = maxValue * fraction;
            const y = PAD_TOP + innerHeight - fraction * innerHeight;
            return (
              <g key={fraction}>
                <line x1={PAD_LEFT} x2={PAD_LEFT + innerWidth} y1={y} y2={y} stroke="rgba(177,173,255,0.12)" strokeWidth={1} />
                <text className={styles.axisText} x={PAD_LEFT - 9} y={y + 3.5} textAnchor="end">
                  {formatValue(value)}
                </text>
              </g>
            );
          })}

          {labels.map((label, groupIndex) => {
            const groupX = PAD_LEFT + groupIndex * groupWidth + (groupWidth - (barWidth * series.length + barGap * (series.length - 1))) / 2;
            return (
              <g key={`${label}-${groupIndex}`}>
                {series.map((entry, seriesIndex) => {
                  const value = entry.values[groupIndex] ?? 0;
                  const barHeight = (value / maxValue) * innerHeight;
                  const x = groupX + seriesIndex * (barWidth + barGap);
                  return (
                    <rect
                      key={entry.key}
                      className={inView ? "bw-anim-grow" : undefined}
                      style={{ "--bw-grow-delay": `${groupIndex * 26 + seriesIndex * 40}ms` } as React.CSSProperties}
                      x={x}
                      y={PAD_TOP + innerHeight - barHeight}
                      width={barWidth}
                      height={barHeight}
                      rx={Math.min(3, barWidth / 2.6)}
                      fill={entry.color}
                      opacity={0.92}
                    >
                      <title>{`${entry.label} — ${label}: ${formatValue(value)}`}</title>
                    </rect>
                  );
                })}
                {showValues
                  ? series.map((entry, seriesIndex) => {
                      const value = entry.values[groupIndex] ?? 0;
                      if (value <= 0) return null;
                      const barHeight = (value / maxValue) * innerHeight;
                      const x = groupX + seriesIndex * (barWidth + barGap) + barWidth / 2;
                      return (
                        <text
                          key={`v-${entry.key}`}
                          className={styles.barValue}
                          x={x}
                          y={PAD_TOP + innerHeight - barHeight - 5}
                          textAnchor="middle"
                        >
                          {formatValue(value)}
                        </text>
                      );
                    })
                  : null}
              </g>
            );
          })}

          {labels.map((label, index) => {
            if (index % maxLabelStride !== 0 && index !== count - 1) return null;
            const x = PAD_LEFT + index * groupWidth + groupWidth / 2;
            return (
              <text
                key={`lbl-${label}-${index}`}
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