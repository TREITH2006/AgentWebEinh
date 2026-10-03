/* =============================================================================
   Dashboard route
   -----------------------------------------------------------------------------
   Server component: copy and structure only. Every interactive piece lives in
   DashboardClient, which owns the single in-flight run.
   ============================================================================= */

import Link from "next/link";

import { DashboardClient } from "@/components/dashboard/DashboardClient";
import { Reveal } from "@/components/ui/Reveal";
import { ArrowRightIcon, ListIcon, ShieldIcon } from "@/components/ui/icons";
import styles from "./page.module.css";

const PROMISES: { icon: React.ReactNode; title: string; body: string }[] = [
  {
    icon: <ListIcon size={16} />,
    title: "One instruction, one report",
    body: "Describe the outcome you need. The agent drives the browser and returns findings, the actions it took, and the sources behind them.",
  },
  {
    icon: <ShieldIcon size={16} />,
    title: "Honest by construction",
    body: "Live data comes from the backend and is labelled. Demo data is visibly simulated, and nothing is ever invented to fill a gap.",
  },
];

export default function DashboardPage(): React.JSX.Element {
  return (
    <div className="bw-shell">
      <section className={styles.hero}>
        <div className={styles.heroCopy}>
          <Reveal>
            <p className={styles.eyebrow}>Browser automation agent</p>
            <h1 className={styles.title}>
              Give it a task.
              <span className={styles.titleAccent}> Get the answer, not the transcript.</span>
            </h1>
            <p className={styles.lede}>
              AgentWebEinh opens the pages you would have to open yourself, works through the steps, and hands back a
              structured report: what it found, what it clicked, and where the information came from.
            </p>
          </Reveal>

          <Reveal delay={90}>
            <ul className={styles.promises}>
              {PROMISES.map((promise) => (
                <li className={styles.promise} key={promise.title}>
                  <span className={styles.promiseIcon}>{promise.icon}</span>
                  <div>
                    <p className={styles.promiseTitle}>{promise.title}</p>
                    <p className={styles.promiseBody}>{promise.body}</p>
                  </div>
                </li>
              ))}
            </ul>
          </Reveal>
        </div>
      </section>

      <div className={styles.workspace}>
        <DashboardClient />
      </div>

      <section className={styles.nextSteps}>
        <Reveal>
          <div className={`bw-panel ${styles.nextPanel}`}>
            <div>
              <h2 className={styles.nextTitle}>While a task runs</h2>
              <p className={styles.nextBody}>
                Follow every event as it happens, watch the reported page change, and stop the run if it drifts. Past
                runs stay available with their full reports.
              </p>
            </div>
            <div className={styles.nextLinks}>
              <Link className={styles.nextLink} href="/tasks">
                <span>Task history</span>
                <ArrowRightIcon size={14} />
              </Link>
              <Link className={styles.nextLink} href="/analytics">
                <span>Analytics</span>
                <ArrowRightIcon size={14} />
              </Link>
              <Link className={styles.nextLink} href="/about">
                <span>How it works</span>
                <ArrowRightIcon size={14} />
              </Link>
            </div>
          </div>
        </Reveal>
      </section>
    </div>
  );
}