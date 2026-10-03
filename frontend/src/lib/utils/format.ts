/* =============================================================================
   Formatting helpers — every number and date the user sees passes through here
   so units, precision and accessibility text stay consistent.
   ============================================================================= */

/** "1m 24s" / "48s" / "2h 05m" — compact, never four digits wide. */
export function formatDuration(ms: number | null | undefined): string {
  if (typeof ms !== "number" || !Number.isFinite(ms) || ms < 0) return "—";
  if (ms < 1_000) return `${Math.round(ms)}ms`;
  const totalSeconds = Math.floor(ms / 1_000);
  const seconds = totalSeconds % 60;
  const minutes = Math.floor(totalSeconds / 60) % 60;
  const hours = Math.floor(totalSeconds / 3_600);
  if (hours > 0) return `${hours}h ${String(minutes).padStart(2, "0")}m`;
  if (minutes > 0) return `${minutes}m ${String(seconds).padStart(2, "0")}s`;
  return `${seconds}s`;
}

/** Longer form used in report metadata and for screen readers. */
export function formatDurationLong(ms: number | null | undefined): string {
  if (typeof ms !== "number" || !Number.isFinite(ms) || ms < 0) return "Unknown";
  if (ms < 1_000) return `${Math.round(ms)} milliseconds`;
  const seconds = Math.floor(ms / 1_000);
  if (seconds < 60) return `${seconds} seconds`;
  const minutes = Math.floor(seconds / 60);
  const remainder = seconds % 60;
  if (minutes < 60) return `${minutes} minute${minutes === 1 ? "" : "s"} ${remainder} second${remainder === 1 ? "" : "s"}`;
  const hours = Math.floor(minutes / 60);
  const mins = minutes % 60;
  return `${hours} hour${hours === 1 ? "" : "s"} ${mins} minute${mins === 1 ? "" : "s"}`;
}

/** Running timer text: "00:14" then "01:02:41". */
export function formatClock(ms: number): string {
  const safe = Math.max(0, Math.floor(ms / 1_000));
  const hours = Math.floor(safe / 3_600);
  const minutes = Math.floor(safe / 60) % 60;
  const seconds = safe % 60;
  if (hours > 0) return `${String(hours).padStart(2, "0")}:${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}`;
  return `${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}`;
}

const RELATIVE_UNITS: readonly { limit: number; divisor: number; unit: Intl.RelativeTimeFormatUnit }[] = [
  { limit: 60_000, divisor: 1_000, unit: "second" },
  { limit: 3_600_000, divisor: 60_000, unit: "minute" },
  { limit: 86_400_000, divisor: 3_600_000, unit: "hour" },
  { limit: 604_800_000, divisor: 86_400_000, unit: "day" },
  { limit: 2_592_000_000, divisor: 604_800_000, unit: "week" },
  { limit: 31_536_000_000, divisor: 2_592_000_000, unit: "month" },
];

export function formatRelative(iso: string | null | undefined, now = Date.now()): string {
  if (!iso) return "—";
  const time = Date.parse(iso);
  if (Number.isNaN(time)) return "—";
  const delta = time - now;
  const magnitude = Math.abs(delta);
  if (magnitude < 45_000) return delta >= 0 ? "in a moment" : "just now";

  for (const entry of RELATIVE_UNITS) {
    if (magnitude < entry.limit) {
      const value = Math.round(delta / entry.divisor);
      return new Intl.RelativeTimeFormat("en", { numeric: "auto" }).format(value, entry.unit);
    }
  }
  return new Intl.RelativeTimeFormat("en", { numeric: "auto" }).format(
    Math.round(delta / 31_536_000_000),
    "year",
  );
}

export function formatDateTime(iso: string | null | undefined): string {
  if (!iso) return "—";
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return "—";
  return new Intl.DateTimeFormat("en", {
    dateStyle: "medium",
    timeStyle: "short",
  }).format(date);
}

export function formatTime(iso: string | null | undefined): string {
  if (!iso) return "—";
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return "—";
  return new Intl.DateTimeFormat("en", { timeStyle: "medium" }).format(date);
}

export function formatDayLabel(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return iso;
  return new Intl.DateTimeFormat("en", { month: "short", day: "numeric" }).format(date);
}

export function formatCompactNumber(value: number): string {
  return new Intl.NumberFormat("en", { notation: "compact", maximumFractionDigits: 1 }).format(value);
}

export function formatNumber(value: number): string {
  return new Intl.NumberFormat("en").format(value);
}

export function formatPercent(ratio: number | null | undefined, digits = 0): string {
  if (typeof ratio !== "number" || !Number.isFinite(ratio)) return "—";
  return `${(ratio * 100).toFixed(digits)}%`;
}

/** `0.834` -> `"83%"`, used for chart axes. */
export function ratioToPercentAxis(ratio: number | null | undefined): string {
  if (typeof ratio !== "number" || !Number.isFinite(ratio)) return "—";
  return `${Math.round(ratio * 100)}%`;
}

export function formatSeconds(ms: number | null | undefined): string {
  if (typeof ms !== "number" || !Number.isFinite(ms)) return "—";
  return `${(ms / 1_000).toFixed(1)}s`;
}

export function hostnameOf(url: string): string | null {
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return null;
  }
}

/** Shortens a long string for a single-line preview. */
export function excerpt(text: string, max = 120): string {
  const clean = text.replace(/\s+/g, " ").trim();
  if (clean.length <= max) return clean;
  return `${clean.slice(0, max - 1).trimEnd()}…`;
}

export function pluralize(count: number, singular: string, plural = `${singular}s`): string {
  return `${count} ${count === 1 ? singular : plural}`;
}

/** `MM:SS.mmm` — used for activity feed timestamps. */
export function formatEventTime(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return "--:--";
  return new Intl.DateTimeFormat("en", {
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  }).format(date);
}

export function isAbsoluteUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return url.protocol === "http:" || url.protocol === "https:";
  } catch {
    return false;
  }
}