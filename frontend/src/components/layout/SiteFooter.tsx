/* =============================================================================
   SiteFooter
   -----------------------------------------------------------------------------
   No social links: the product does not have any, so adding placeholder icons
   would be decorative clutter. Navigation and attribution only.
   ============================================================================= */

import Link from "next/link";

import { Logo } from "./Logo";
import styles from "./SiteFooter.module.css";

const GROUPS: readonly { title: string; links: readonly { href: string; label: string }[] }[] = [
  {
    title: "Product",
    links: [
      { href: "/", label: "Dashboard" },
      { href: "/tasks", label: "Task history" },
      { href: "/analytics", label: "Performance" },
      { href: "/connect", label: "Connect a browser" },
    ],
  },
  {
    title: "Learn",
    links: [
      { href: "/about", label: "How it works" },
      { href: "/about#capabilities", label: "What you can do" },
      { href: "/about#performance", label: "Performance overview" },
    ],
  },
];

export function SiteFooter(): React.JSX.Element {
  return (
    <footer className={styles.footer}>
      <div className={`bw-shell-wide ${styles.inner}`}>
        <div className={styles.brand}>
          <Logo size="sm" />
          <p className={styles.tagline}>
            Describe the task. Watch it happen. Get a clear result.
          </p>
          <p className={styles.attribution}>
            <span className={styles.attributionDot} aria-hidden="true" />
            Vibecoded by Adithya
          </p>
        </div>

        {GROUPS.map((group) => (
          <nav key={group.title} className={styles.group} aria-label={group.title}>
            <h2 className={styles.groupTitle}>{group.title}</h2>
            <ul className={styles.groupList}>
              {group.links.map((link) => (
                <li key={link.href}>
                  <Link href={link.href} className={styles.link}>
                    {link.label}
                  </Link>
                </li>
              ))}
            </ul>
          </nav>
        ))}
      </div>

      <div className={`bw-shell-wide ${styles.legal}`}>
        <p>AgentWebEinh — browser automation you can watch.</p>
        <p>
          Tasks are performed by an automated browser agent. Always review a report before acting on its findings.
        </p>
      </div>
    </footer>
  );
}