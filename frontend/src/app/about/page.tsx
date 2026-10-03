/* =============================================================================
   About route
   -----------------------------------------------------------------------------
   Explains what the product is, what it deliberately will not do, how the data
   flows, and how the interface was designed. Static content only.
   ============================================================================= */

import type { Metadata } from "next";
import Link from "next/link";

import { PageHeader } from "@/components/layout/PageHeader";
import { Reveal } from "@/components/ui/Reveal";
import {
  AlertIcon,
  CheckIcon,
  ChartIcon,
  GlobeIcon,
  LayersIcon,
  ListIcon,
  MousePointerIcon,
  ShieldIcon,
  SparkIcon,
} from "@/components/ui/icons";
import styles from "./page.module.css";

export const metadata: Metadata = {
  title: "About",
  description: "What AgentWebEinh does, how it talks to the backend, and the rules the interface follows.",
};

const CAPABILITIES: { icon: React.ReactNode; title: string; body: string }[] = [
  {
    icon: <MousePointerIcon size={16} />,
    title: "Drives a real browser",
    body: "Navigation, element inspection, clicks and form interactions are performed by the backend agent. The interface only displays what it reports.",
  },
  {
    icon: <LayersIcon size={16} />,
    title: "Structured results, not screenshots",
    body: "Every run returns a report: a summary, the actions taken, discrete findings, the source URLs, and any limitations worth knowing.",
  },
  {
    icon: <GlobeIcon size={16} />,
    title: "Streams while it works",
    body: "Events arrive over WebSocket when the backend supports it and fall back to polling when it does not. The transport in use is always shown.",
  },
  {
    icon: <ChartIcon size={16} />,
    title: "History and analytics",
    body: "Runs are searchable, filterable and summarised, so a pattern across many tasks becomes visible instead of anecdotal.",
  },
];

const PRINCIPLES: { icon: React.ReactNode; title: string; body: string }[] = [
  {
    icon: <ShieldIcon size={16} />,
    title: "Never invent data",
    body: "No placeholder screenshots, no made-up progress bars, no fabricated findings. If a capability is missing the interface says so plainly.",
  },
  {
    icon: <AlertIcon size={16} />,
    title: "Label the origin",
    body: "Everything the interface renders is tagged as backend data or demo data. Demo mode is visible in the header, the menus and each affected record.",
  },
  {
    icon: <CheckIcon size={16} />,
    title: "Only one accent family",
    body: "The interface uses a five-colour warm ramp and nothing else. Status is communicated with shape and label as well as colour.",
  },
  {
    icon: <SparkIcon size={16} />,
    title: "Motion with a purpose",
    body: "Animation marks state changes, new data and progress. It is short, it never blocks input, and it stops entirely under reduced-motion.",
  },
];

const PIPELINE: { label: string; body: string }[] = [
  { label: "1 · Instruction", body: "You describe the task in plain language, with as much or as little detail as you like." },
  { label: "2 · Submission", body: "The prompt is posted to the backend and a task id is returned immediately." },
  { label: "3 · Execution", body: "The agent opens a browser and works through the task, emitting an event for each meaningful step." },
  { label: "4 · Report", body: "On completion the task carries a report: summary, actions, findings, sources and limitations." },
  { label: "5 · Record", body: "The run is stored, searchable in history and rolled into the analytics views." },
];

export default function AboutPage(): React.JSX.Element {
  return (
    <div className="bw-shell">
      <PageHeader
        eyebrow="About"
        title="A browser agent you can actually audit"
        lede="AgentWebEinh turns a written instruction into a structured, traceable result — and shows its working the whole way through."
      />

      <section className={styles.section} aria-label="What it does">
        <Reveal>
          <h2 className={styles.sectionTitle}>What it does</h2>
        </Reveal>
        <div className={styles.cards}>
          {CAPABILITIES.map((item, index) => (
            <Reveal key={item.title} delay={index * 60}>
              <article className={`bw-panel ${styles.card}`}>
                <span className={styles.cardIcon}>{item.icon}</span>
                <h3 className={styles.cardTitle}>{item.title}</h3>
                <p className={styles.cardBody}>{item.body}</p>
              </article>
            </Reveal>
          ))}
        </div>
      </section>

      <section className={styles.section} aria-label="How a task flows">
        <Reveal>
          <h2 className={styles.sectionTitle}>How a task flows</h2>
        </Reveal>
        <ol className={styles.pipeline}>
          {PIPELINE.map((step, index) => (
            <Reveal as="li" key={step.label} delay={index * 50}>
              <div className={styles.step}>
                <p className={styles.stepLabel}>{step.label}</p>
                <p className={styles.stepBody}>{step.body}</p>
              </div>
            </Reveal>
          ))}
        </ol>
      </section>

      <section className={styles.section} aria-label="Interface rules">
        <Reveal>
          <h2 className={styles.sectionTitle}>The rules this interface follows</h2>
        </Reveal>
        <ul className={styles.principles}>
          {PRINCIPLES.map((item, index) => (
            <Reveal as="li" key={item.title} delay={index * 60}>
              <div className={styles.principle}>
                <span className={styles.principleIcon}>{item.icon}</span>
                <div>
                  <p className={styles.principleTitle}>{item.title}</p>
                  <p className={styles.principleBody}>{item.body}</p>
                </div>
              </div>
            </Reveal>
          ))}
        </ul>
      </section>

      <section className={styles.section} aria-label="Data sources">
        <Reveal>
          <div className={`bw-panel ${styles.notePanel}`}>
            <h2 className={styles.sectionTitle}>Two data sources, never mixed</h2>
            <p className={styles.noteBody}>
              In <strong>live mode</strong> every value on screen comes from the AgentWebEinh backend over its REST API,
              with WebSocket events and optional browser frames. In <strong>demo mode</strong> the interface runs against
              deterministic fixtures so it can be explored without a backend — clearly marked everywhere it appears.
              The data-source control in the header switches between them, and the interface never blurs the two.
            </p>
            <div className={styles.noteActions}>
              <Link className={styles.noteCta} href="/">
                <ListIcon size={15} />
                Start a task
              </Link>
              <Link className={styles.noteLink} href="/analytics">
                See analytics
              </Link>
            </div>
          </div>
        </Reveal>
      </section>
    </div>
  );
}