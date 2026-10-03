/* =============================================================================
   DEMO DATA — NOT AGENT OUTPUT
   -----------------------------------------------------------------------------
   Everything in `src/lib/demo/` is synthetic. It exists so the interface can be
   developed and reviewed without a backend. It is:

     * generated from a fixed seed, so charts are stable across renders;
     * tagged `origin: "demo"` on every domain object;
     * rendered behind a visible "Demo data" marker by the UI;
     * never mixed with `origin: "api"` records anywhere in the app.

   Delete this folder once the backend is connected — nothing outside it imports
   anything but `fixtures.ts` and `simulator.ts`.
   ============================================================================= */

import type { DataOrigin, StatsBucket, TaskRecord, TaskReport } from "@/types/domain";

export const DEMO_ORIGIN: DataOrigin = "demo";

/* --------------------------------------------------------------- utilities -- */

/** Deterministic PRNG (mulberry32). Same seed always yields the same series. */
function makeRng(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function hashString(input: string): number {
  let hash = 2166136261;
  for (let i = 0; i < input.length; i += 1) {
    hash ^= input.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  return hash >>> 0;
}

function pickFrom<T>(list: readonly T[], rng: () => number): T {
  const item = list[Math.floor(rng() * list.length) % list.length];
  return item as T;
}

function roundTo(value: number, step: number): number {
  return Math.round(value / step) * step;
}

/* --------------------------------------------------------------- archetypes -- */

interface Archetype {
  key: string;
  title: string;
  prompt: string;
  domain: string;
  sites: { url: string; title: string }[];
  actions: { label: string; target: string }[];
  findings: { label: string; value: string }[];
  summary: string;
  limitations: string[];
}

const ARCHETYPES: readonly Archetype[] = [
  {
    key: "flights",
    title: "Compare flight prices to Lisbon",
    prompt:
      "Find the cheapest one-way flights from Bengaluru to Lisbon departing in January and summarise the three best options with price, airline and total duration.",
    domain: "flight search",
    sites: [
      { url: "https://www.google.com/travel/flights", title: "Google Flights — Bengaluru to Lisbon" },
      { url: "https://www.skyscanner.net/transport/flights/bga/lis/", title: "Skyscanner — BGA to LIS" },
    ],
    actions: [
      { label: "Opened the flight search page", target: "origin and destination inputs" },
      { label: "Typed origin city and selected Bengaluru (BLR)", target: "#origin" },
      { label: "Typed destination city and selected Lisbon (LIS)", target: "#destination" },
      { label: "Set departure month to January", target: "date picker" },
      { label: "Applied the lowest-price sort", target: "sort control" },
      { label: "Read the first three result rows", target: "result list" },
    ],
    findings: [
      { label: "Best fare", value: "₹41,280 — Indigo, 1 stop via Doha, 14h 20m" },
      { label: "Second option", value: "₹44,650 — Air India Express, 1 stop via Muscat, 15h 05m" },
      { label: "Third option", value: "₹46,910 — Turkish Airlines, 2 stops, 18h 40m" },
      { label: "Currency note", value: "Prices shown in INR, taxes included, 1 adult, economy" },
    ],
    summary:
      "Compared one-way Bengaluru to Lisbon fares for January across two travel sites. The lowest available fare was ₹41,280 on Indigo with one stop in Doha and a total travel time of 14h 20m.",
    limitations: [
      "Fares were captured at a single moment and change frequently.",
      "Baggage and seat fees were not included in the comparison.",
    ],
  },
  {
    key: "github",
    title: "Collect trending GitHub repositories",
    prompt:
      "Open the GitHub trending page, collect the top 5 trending repositories for today with their descriptions, primary language and star counts.",
    domain: "developer tools",
    sites: [{ url: "https://github.com/trending", title: "GitHub Trending" }],
    actions: [
      { label: "Opened GitHub Trending", target: "github.com/trending" },
      { label: "Confirmed the time range is Today", target: "language filter" },
      { label: "Read each repository row", target: "article.Box-row" },
      { label: "Expanded descriptions for truncated entries", target: "repository description" },
      { label: "Collected star counts", target: "stargazers link" },
    ],
    findings: [
      { label: "1. agent-browser", value: "TypeScript · 4,182 stars — Headless browser control for coding agents." },
      { label: "2. tiny-renderer", value: "Rust · 3,764 stars — Experimental zero-copy terminal renderer." },
      { label: "3. promptkit", value: "Python · 3,051 stars — Typed prompt pipelines with schema validation." },
      { label: "4. web-agent-bench", value: "Jupyter Notebook · 2,688 stars — Reproducible benchmark for web agents." },
      { label: "5. edge-cache-kit", value: "Go · 2,213 stars — Small caching layer for edge runtimes." },
    ],
    summary:
      "Read the GitHub trending page for today and captured the top 5 repositories with their descriptions, primary language and star counts. All entries came from the default Today ranking.",
    limitations: [
      "Trending rankings change hourly, so this snapshot will drift.",
      "Only the default language filter (all languages) was used.",
    ],
  },
  {
    key: "weather",
    title: "Seven-day forecast for Kochi",
    prompt:
      "Check the seven-day weather forecast for Kochi, India and list the daily high and low with a short summary of the conditions.",
    domain: "weather",
    sites: [{ url: "https://weather.com/weather/tenday/l/Kochi+Kerala+India", title: "Kochi 10-day forecast" }],
    actions: [
      { label: "Opened the Kochi forecast page", target: "search input" },
      { label: "Searched for Kochi, Kerala", target: "search box" },
      { label: "Selected the 7-day view", target: "day range toggle" },
      { label: "Read each daily row", target: "daily forecast list" },
    ],
    findings: [
      { label: "Today", value: "29° / 24° — Partly cloudy, chance of afternoon showers" },
      { label: "Tomorrow", value: "30° / 24° — Humid with isolated thunderstorms" },
      { label: "Day 3", value: "28° / 23° — Heavy monsoon rain, 78% precipitation" },
      { label: "Day 4", value: "27° / 23° — Rain continuing through the morning" },
      { label: "Week outlook", value: "Rainfall eases from day 5, highs holding near 29°" },
    ],
    summary:
      "Pulled the seven-day outlook for Kochi. Heavy monsoon rain is expected through day 4 with highs between 27° and 30° and overnight lows near 23–24°.",
    limitations: ["Forecasts beyond three days carry lower confidence and change frequently."],
  },
  {
    key: "releases",
    title: "Summarise recent Node.js releases",
    prompt:
      "Find the two most recent Node.js releases on the official site and summarise what changed in each, including the release date.",
    domain: "software releases",
    sites: [
      { url: "https://nodejs.org/en/download/releases", title: "Node.js releases" },
      { url: "https://github.com/nodejs/node/releases", title: "nodejs/node releases" },
    ],
    actions: [
      { label: "Opened the Node.js releases index", target: "release table" },
      { label: "Opened the newest LTS release notes", target: "first row of current releases" },
      { label: "Read the highlights section", target: "release notes body" },
      { label: "Opened the previous release notes", target: "previous row" },
      { label: "Recorded release dates from the header", target: "release date" },
    ],
    findings: [
      { label: "Latest release", value: "Node.js 24.7.0 — released this month. Adds request signal propagation, a faster module resolver and a new permission-model flag." },
      { label: "Previous release", value: "Node.js 24.6.1 — released last month. Primarily security and dependency bumps with a fix for a stream backpressure leak." },
      { label: "Support line", value: "v24 is the active LTS line; v22 remains in maintenance until April." },
    ],
    summary:
      "Identified the two newest Node.js releases from the official release index and summarised the headline changes in each, with dates taken from the release headers.",
    limitations: ["Notes were summarised from the highlights section only, not every commit."],
  },
  {
    key: "shopping",
    title: "Compare mechanical keyboards under $100",
    prompt:
      "Search for mechanical keyboards priced under $100 on the store, filter to 65% layout, and list the four cheapest with price and switch type.",
    domain: "product research",
    sites: [
      { url: "https://www.newegg.com/p/pl?d=mechanical+keyboard+65", title: "Mechanical keyboards (65%)" },
      { url: "https://www.amazon.com/s?k=mechanical+keyboard+65+layout", title: "Amazon — 65% mechanical keyboards" },
    ],
    actions: [
      { label: "Opened the store search page", target: "search input" },
      { label: "Entered the product query", target: "search box" },
      { label: "Applied the 65% layout filter", target: "layout facet" },
      { label: "Applied the under $100 price filter", target: "price facet" },
      { label: "Sorted by price ascending", target: "sort control" },
      { label: "Read switch type from four product cards", target: "product grid" },
    ],
    findings: [
      { label: "Cheapest", value: "$54.99 — Aurora 68 Hot-swap, linear switches" },
      { label: "Second", value: "$62.50 — Kestrel 65 Pro, tactile switches" },
      { label: "Third", value: "$71.99 — Meridian 65, linear switches" },
      { label: "Fourth", value: "$79.00 — Lumen Compact, clicky switches" },
    ],
    summary:
      "Filtered to 65% layout mechanical keyboards under $100 and captured the four cheapest listings with their switch types. Prices include the currently displayed sale pricing.",
    limitations: [
      "Stock status was not verified for every listing.",
      "Shipping was excluded from the comparison.",
    ],
  },
  {
    key: "docs",
    title: "Locate WebSocket reconnect guidance",
    prompt:
      "Find the official documentation page covering WebSocket reconnection backoff, quote the recommended initial delay and maximum interval, and give the page URL.",
    domain: "documentation",
    sites: [{ url: "https://developer.mozilla.org/en-US/docs/Web/API/WebSocket_API", title: "MDN — WebSocket API" }],
    actions: [
      { label: "Opened the documentation site", target: "root" },
      { label: "Searched for reconnection backoff", target: "site search" },
      { label: "Opened the reconnection guide page", target: "first result" },
      { label: "Read the backoff recommendation", target: "reconnection section" },
      { label: "Confirmed the section anchor", target: "heading id" },
    ],
    findings: [
      { label: "Recommended initial delay", value: "1 second" },
      { label: "Maximum backoff interval", value: "30 seconds, with exponential growth and jitter" },
      { label: "Section", value: "Reconnection — 'a good starting point is one second, doubling up to a maximum of thirty'" },
    ],
    summary:
      "Located the official WebSocket reconnection guidance and extracted the recommended initial delay of one second and a maximum interval of thirty seconds with exponential growth and jitter.",
    limitations: ["The guidance is advisory; the exact values differ between implementations."],
  },
  {
    key: "pricing",
    title: "Collect competitor pricing tiers",
    prompt:
      "Open the pricing page of the project management tool and list every plan name with its monthly and annual price, then note which features are gated to the top tier.",
    domain: "pricing research",
    sites: [{ url: "https://linear.app/pricing", title: "Linear — Pricing" }],
    actions: [
      { label: "Opened the pricing page", target: "pricing nav item" },
      { label: "Toggled to annual billing", target: "billing period switch" },
      { label: "Read each plan card", target: "plan grid" },
      { label: "Opened the feature comparison table", target: "comparison link" },
      { label: "Scanned for top-tier only features", target: "comparison table rows" },
    ],
    findings: [
      { label: "Free", value: "$0 — up to 5 members, unlimited issues" },
      { label: "Basic", value: "$8 per user/month annually ($10 monthly)" },
      { label: "Business", value: "$14 per user/month annually ($16 monthly)" },
      { label: "Enterprise", value: "Custom — contact sales" },
      { label: "Top-tier only", value: "SAML SSO, audit log retention beyond 90 days, and data residency selection" },
    ],
    summary:
      "Collected all four pricing plans with both monthly and annual rates and identified SAML SSO, extended audit retention and data residency as enterprise-only features.",
    limitations: ["Enterprise pricing is not published and requires contacting sales."],
  },
  {
    key: "events",
    title: "Summarise a conference schedule",
    prompt:
      "Open the conference schedule, find all sessions in the main hall for Thursday, and list each with its time slot and speaker.",
    domain: "events",
    sites: [{ url: "https://www.pycon.org/schedule/", title: "Conference schedule" }],
    actions: [
      { label: "Opened the schedule page", target: "schedule nav item" },
      { label: "Switched to Thursday", target: "day tabs" },
      { label: "Filtered to the main hall", target: "room filter" },
      { label: "Read each session row", target: "session grid" },
      { label: "Expanded abstracts for short entries", target: "session detail" },
    ],
    findings: [
      { label: "09:00", value: "Opening keynote — Dr. A. Menon" },
      { label: "11:00", value: "Scaling ingestion pipelines — S. Rao" },
      { label: "14:00", value: "Panel: agents in production — moderated by J. Fernandes" },
      { label: "16:30", value: "Lightning talks — eight speakers, five minutes each" },
    ],
    summary:
      "Found four sessions scheduled in the main hall on Thursday and listed each with its time slot and speaker, expanding abstracts where the listing was truncated.",
    limitations: ["Room assignments were not included in the listing and may change on the day."],
  },
] as const;

/* ------------------------------------------------------------- task history -- */

const FAILED_REASONS = [
  "The sign-in page required a one-time code that could not be supplied automatically.",
  "The page refused repeated requests after three attempts and returned HTTP 429.",
  "The requested record does not exist for the selected date range.",
  "A consent dialog blocked the results table and could not be dismissed automatically.",
] as const;

function buildReport(archetype: Archetype, rng: () => number): TaskReport {
  const accessed = new Date(Date.now() - Math.floor(rng() * 20) * 86_400_000);
  return {
    summary: archetype.summary,
    actions: archetype.actions.map((action, index) => ({
      index: index + 1,
      at: new Date(accessed.getTime() + index * 21_000).toISOString(),
      label: action.label,
      target: action.target,
      url: archetype.sites[Math.min(index, archetype.sites.length - 1)]?.url ?? null,
      status: "performed" as const,
      detail: null,
    })),
    findings: archetype.findings.map((finding, index) => ({
      label: finding.label,
      value: finding.value,
      note: index === 0 ? "First result on the page." : null,
      sourceUrl: archetype.sites[index % archetype.sites.length]?.url ?? null,
    })),
    sources: archetype.sites.map((site) => ({
      url: site.url,
      title: site.title,
      domain: new URL(site.url).hostname.replace(/^www\./, ""),
      accessedAt: accessed.toISOString(),
    })),
    limitations: [...archetype.limitations],
    raw: null,
  };
}

function makeTask(index: number, createdAt: Date, status: TaskRecord["status"]): TaskRecord {
  const archetype = ARCHETYPES[index % ARCHETYPES.length] as Archetype;
  const seed = hashString(`${archetype.key}:${index}`);
  const rng = makeRng(seed);

  const startedAt = new Date(createdAt.getTime() + 900 + Math.floor(rng() * 4_000));
  const durationMs = status === "completed" ? 48_000 + Math.floor(rng() * 190_000) : status === "failed" ? 22_000 + Math.floor(rng() * 70_000) : 12_000 + Math.floor(rng() * 40_000);
  const completedAt = new Date(startedAt.getTime() + durationMs);

  const base: TaskRecord = {
    id: `demo-${String(index + 1).padStart(3, "0")}`,
    prompt: archetype.prompt,
    title: archetype.title,
    status,
    origin: DEMO_ORIGIN,
    createdAt: createdAt.toISOString(),
    startedAt: startedAt.toISOString(),
    completedAt: status === "queued" ? null : completedAt.toISOString(),
    durationMs: status === "queued" ? null : durationMs,
    progress: status === "completed" ? 1 : status === "running" ? Math.round(rng() * 70) / 100 : null,
    currentActivity:
      status === "running"
        ? pickFrom(
            ["Reading the results table", "Waiting for the page to settle", "Extracting product details", "Checking the next page"] as const,
            rng,
          )
        : null,
    currentUrl: status === "completed" || status === "running" ? (archetype.sites[0]?.url ?? null) : null,
    currentTitle: status === "completed" || status === "running" ? (archetype.sites[0]?.title ?? null) : null,
    report: status === "completed" ? buildReport(archetype, rng) : null,
    error:
      status === "failed"
        ? {
            message: pickFrom(FAILED_REASONS, rng),
            code: pickFrom(["AUTH_REQUIRED", "RATE_LIMITED", "NOT_FOUND", "BLOCKED"] as const, rng),
            retryable: rng() > 0.5,
          }
        : null,
  };

  return base;
}

/** Status distribution roughly matching the demo success rate we advertise. */
const STATUS_WEIGHTS: readonly { status: TaskRecord["status"]; weight: number }[] = [
  { status: "completed", weight: 74 },
  { status: "failed", weight: 12 },
  { status: "cancelled", weight: 6 },
  { status: "running", weight: 4 },
  { status: "queued", weight: 4 },
];

function pickStatus(rng: () => number): TaskRecord["status"] {
  const total = STATUS_WEIGHTS.reduce((sum, entry) => sum + entry.weight, 0);
  let roll = rng() * total;
  for (const entry of STATUS_WEIGHTS) {
    roll -= entry.weight;
    if (roll <= 0) return entry.status;
  }
  return "completed";
}

/** Build the demo history: newest first. */
export function getDemoTasks(count = 42): TaskRecord[] {
  const rng = makeRng(20_260_301);
  const now = Date.now();
  const tasks: TaskRecord[] = [];

  for (let i = 0; i < count; i += 1) {
    // Spread tasks across the last 30 days with more density recently.
    const hoursAgo = Math.round(((i + rng() * 0.7) / count) ** 1.4 * 30 * 24);
    const createdAt = new Date(now - hoursAgo * 3_600_000);
    const status = i === 0 ? "completed" : pickStatus(rng);
    tasks.push(makeTask(i, createdAt, status));
  }

  return tasks.sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime());
}

/** Archetype selected for a given prompt so the simulator matches the request. */
export function archetypeForPrompt(prompt: string): Archetype {
  const seed = hashString(prompt.trim().toLowerCase() || "default");
  return ARCHETYPES[seed % ARCHETYPES.length] as Archetype;
}

export function archetypeByKey(key: string): Archetype | null {
  return ARCHETYPES.find((entry) => entry.key === key) ?? null;
}

/* ------------------------------------------------------------------ stats -- */

/** Daily buckets for the last `days` days, derived from the demo history. */
export function getDemoBuckets(days: number, tasks: TaskRecord[]): StatsBucket[] {
  const buckets: StatsBucket[] = [];
  // Bucket keys are compared against `createdAt.toISOString()`, so the day
  // boundary has to be UTC midnight too. Using local midnight would shift every
  // key by a day for anyone east or west of UTC.
  const today = new Date();
  today.setUTCHours(0, 0, 0, 0);

  const byDay = new Map<string, TaskRecord[]>();
  for (const task of tasks) {
    const key = task.createdAt.slice(0, 10);
    const list = byDay.get(key) ?? [];
    list.push(task);
    byDay.set(key, list);
  }

  for (let offset = days - 1; offset >= 0; offset -= 1) {
    const day = new Date(today.getTime() - offset * 86_400_000);
    const key = day.toISOString().slice(0, 10);
    const entries = byDay.get(key) ?? [];
    const completed = entries.filter((task) => task.status === "completed");
    const failed = entries.filter((task) => task.status === "failed");
    const cancelled = entries.filter((task) => task.status === "cancelled");
    const finished = [...completed, ...failed];
    const decided = completed.length + failed.length;
    const durations = finished
      .map((task) => task.durationMs)
      .filter((value): value is number => typeof value === "number" && value > 0);

    buckets.push({
      date: key,
      performed: entries.length,
      completed: completed.length,
      failed: failed.length,
      cancelled: cancelled.length,
      durationMs: durations.length ? roundTo(durations.reduce((sum, value) => sum + value, 0) / durations.length, 1_000) : null,
      successRate: decided > 0 ? completed.length / decided : null,
    });
  }

  return buckets;
}

export function getDemoStats(days: number): {
  buckets: StatsBucket[];
  tasks: TaskRecord[];
} {
  const tasks = getDemoTasks(48);
  return { buckets: getDemoBuckets(days, tasks), tasks };
}

/** Archetypes are surfaced by the composer's suggestion chips. */
export function getDemoSuggestions(): readonly { label: string; prompt: string }[] {
  return ARCHETYPES.slice(0, 4).map((entry) => ({ label: entry.title, prompt: entry.prompt }));
}