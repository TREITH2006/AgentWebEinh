"use client";

/* =============================================================================
   SiteHeader — product navigation
   -----------------------------------------------------------------------------
   Active-route indication uses both colour and an underline bar, and the current
   link is marked `aria-current` for assistive technology. The mobile drawer
   closes on navigation and on Escape.
   ============================================================================= */

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useEffect, useState } from "react";

import { Logo } from "./Logo";
import { DataSourceMenu } from "./DataSourceMenu";
import { AnimatedLink } from "@/components/ui/AnimatedButton";
import { CloseIcon, MenuIcon } from "@/components/ui/icons";
import { useScrollLock } from "@/lib/hooks/useUtilities";
import styles from "./SiteHeader.module.css";

interface NavItem {
  href: string;
  label: string;
}

const NAV: readonly NavItem[] = [
  { href: "/", label: "Dashboard" },
  { href: "/tasks", label: "Tasks" },
  { href: "/analytics", label: "Analytics" },
  { href: "/connect", label: "Connect" },
  { href: "/about", label: "About" },
];

function isActive(pathname: string, href: string): boolean {
  if (href === "/") return pathname === "/";
  return pathname === href || pathname.startsWith(`${href}/`);
}

export function SiteHeader(): React.JSX.Element {
  const pathname = usePathname();
  const [open, setOpen] = useState(false);
  const [scrolled, setScrolled] = useState(false);

  useScrollLock(open);

  useEffect(() => {
    setOpen(false);
  }, [pathname]);

  useEffect(() => {
    const onScroll = () => setScrolled(window.scrollY > 8);
    onScroll();
    window.addEventListener("scroll", onScroll, { passive: true });
    return () => window.removeEventListener("scroll", onScroll);
  }, []);

  useEffect(() => {
    if (!open) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") setOpen(false);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open]);

  return (
    <header className={styles.header} data-scrolled={scrolled || undefined}>
      <div className={`bw-shell-wide ${styles.inner}`}>
        <Logo />

        <nav className={styles.desktopNav} aria-label="Primary">
          <ul className={styles.navList}>
            {NAV.map((item) => {
              const active = isActive(pathname, item.href);
              return (
                <li key={item.href}>
                  <Link
                    href={item.href}
                    className={styles.navLink}
                    data-active={active || undefined}
                    aria-current={active ? "page" : undefined}
                  >
                    {item.label}
                  </Link>
                </li>
              );
            })}
          </ul>
        </nav>

        <div className={styles.actions}>
          <DataSourceMenu />
          <AnimatedLink href="/" label="New task" size="sm" className={styles.cta} />
          <button
            type="button"
            className={styles.burger}
            onClick={() => setOpen((value) => !value)}
            aria-expanded={open}
            aria-controls="mobile-nav"
            aria-label={open ? "Close navigation" : "Open navigation"}
          >
            {open ? <CloseIcon size={19} /> : <MenuIcon size={19} />}
          </button>
        </div>
      </div>

      <div className={styles.mobileWrap} data-open={open || undefined} id="mobile-nav">
        <nav className={`bw-shell-wide ${styles.mobileNav}`} aria-label="Primary (mobile)">
          <ul className={styles.mobileList}>
            {NAV.map((item) => {
              const active = isActive(pathname, item.href);
              return (
                <li key={item.href}>
                  <Link
                    href={item.href}
                    className={styles.mobileLink}
                    data-active={active || undefined}
                    aria-current={active ? "page" : undefined}
                  >
                    {item.label}
                  </Link>
                </li>
              );
            })}
          </ul>
          <AnimatedLink href="/" label="Start a task" fullWidth />
        </nav>
      </div>
    </header>
  );
}