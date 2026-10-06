/* =============================================================================
   Icon set
   -----------------------------------------------------------------------------
   Hand-picked inline SVG paths on a 24x24 grid. Inline keeps the bundle free of
   an icon dependency and lets every glyph inherit `currentColor`, so icons stay
   inside the brand palette automatically.

   All icons are decorative by default (`aria-hidden`); pass a `title` when an
   icon is the only label for a control.
   ============================================================================= */

import type { SVGProps } from "react";

export type IconProps = SVGProps<SVGSVGElement> & { size?: number };

function Base({ size = 18, children, ...rest }: IconProps): React.JSX.Element {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.7}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
      {...rest}
    >
      {children}
    </svg>
  );
}

/* ------------------------------------------------------------- interface -- */

export function SparkIcon(props: IconProps): React.JSX.Element {
  return (
    <Base {...props}>
      <path d="M12 3.2l1.9 5.1 5.1 1.9-5.1 1.9L12 17.2l-1.9-5.1L5 10.2l5.1-1.9L12 3.2Z" />
      <path d="M18.5 15.5l.8 2.2 2.2.8-2.2.8-.8 2.2-.8-2.2-2.2-.8 2.2-.8.8-2.2Z" />
    </Base>
  );
}

export function PlayIcon(props: IconProps): React.JSX.Element {
  return (
    <Base {...props}>
      <path d="M8 5.6v12.8a.8.8 0 0 0 1.22.68l10-6.4a.8.8 0 0 0 0-1.36l-10-6.4A.8.8 0 0 0 8 5.6Z" />
    </Base>
  );
}

export function StopIcon(props: IconProps): React.JSX.Element {
  return (
    <Base {...props}>
      <rect x="6.5" y="6.5" width="11" height="11" rx="2.4" />
    </Base>
  );
}

export function RefreshIcon(props: IconProps): React.JSX.Element {
  return (
    <Base {...props}>
      <path d="M20 11.5a8 8 0 1 0-1.6 5.6" />
      <path d="M20 5.5v6h-6" />
    </Base>
  );
}

export function SearchIcon(props: IconProps): React.JSX.Element {
  return (
    <Base {...props}>
      <circle cx="11" cy="11" r="6.4" />
      <path d="m16 16 4 4" />
    </Base>
  );
}

export function CloseIcon(props: IconProps): React.JSX.Element {
  return (
    <Base {...props}>
      <path d="m6 6 12 12M18 6 6 18" />
    </Base>
  );
}

export function ArrowRightIcon(props: IconProps): React.JSX.Element {
  return (
    <Base {...props}>
      <path d="M4.5 12h14M13 6.5l5.5 5.5-5.5 5.5" />
    </Base>
  );
}

export function ArrowLeftIcon(props: IconProps): React.JSX.Element {
  return (
    <Base {...props}>
      <path d="M19.5 12h-14M11 6.5 5.5 12l5.5 5.5" />
    </Base>
  );
}

export function ExternalLinkIcon(props: IconProps): React.JSX.Element {
  return (
    <Base {...props}>
      <path d="M14 5h5v5" />
      <path d="M19 5 10.5 13.5" />
      <path d="M18.5 14.5V18a2 2 0 0 1-2 2H6.5a2 2 0 0 1-2-2V8.5a2 2 0 0 1 2-2H10" />
    </Base>
  );
}

export function DownloadIcon(props: IconProps): React.JSX.Element {
  return (
    <Base {...props}>
      <path d="M12 4v10.5" />
      <path d="m7.5 10.5 4.5 4.5 4.5-4.5" />
      <path d="M5 19.5h14" />
    </Base>
  );
}

export function CopyIcon(props: IconProps): React.JSX.Element {
  return (
    <Base {...props}>
      <rect x="9" y="9" width="11" height="11" rx="2.4" />
      <path d="M15 6.5V6a2 2 0 0 0-2-2H6a2 2 0 0 0-2 2v7a2 2 0 0 0 2 2h.5" />
    </Base>
  );
}

export function CheckIcon(props: IconProps): React.JSX.Element {
  return (
    <Base {...props}>
      <path d="m5 12.5 4.5 4.5L19 7.5" />
    </Base>
  );
}

export function AlertIcon(props: IconProps): React.JSX.Element {
  return (
    <Base {...props}>
      <circle cx="12" cy="12" r="8.6" />
      <path d="M12 7.8v5.4M12 16.4h.01" />
    </Base>
  );
}

export function InfoIcon(props: IconProps): React.JSX.Element {
  return (
    <Base {...props}>
      <circle cx="12" cy="12" r="8.6" />
      <path d="M12 11v5.4M12 7.8h.01" />
    </Base>
  );
}

export function ClockIcon(props: IconProps): React.JSX.Element {
  return (
    <Base {...props}>
      <circle cx="12" cy="12" r="8.4" />
      <path d="M12 7.6V12l3 1.8" />
    </Base>
  );
}

export function ChevronDownIcon(props: IconProps): React.JSX.Element {
  return (
    <Base {...props}>
      <path d="m6.5 9.5 5.5 5.5 5.5-5.5" />
    </Base>
  );
}

export function ChevronRightIcon(props: IconProps): React.JSX.Element {
  return (
    <Base {...props}>
      <path d="m9.5 6.5 5.5 5.5-5.5 5.5" />
    </Base>
  );
}

export function ListIcon(props: IconProps): React.JSX.Element {
  return (
    <Base {...props}>
      <path d="M8.5 7h11M8.5 12h11M8.5 17h11" />
      <path d="M4.5 7h.01M4.5 12h.01M4.5 17h.01" />
    </Base>
  );
}

export function ChartIcon(props: IconProps): React.JSX.Element {
  return (
    <Base {...props}>
      <path d="M4 19.5h16" />
      <path d="M7 19.5v-6M12 19.5V7M17 19.5v-9" />
    </Base>
  );
}

export function GlobeIcon(props: IconProps): React.JSX.Element {
  return (
    <Base {...props}>
      <circle cx="12" cy="12" r="8.6" />
      <path d="M3.6 12h16.8" />
      <path d="M12 3.4c2.2 2.4 3.4 5.4 3.4 8.6S14.2 18.2 12 20.6c-2.2-2.4-3.4-5.4-3.4-8.6S9.8 5.8 12 3.4Z" />
    </Base>
  );
}

export function MousePointerIcon(props: IconProps): React.JSX.Element {
  return (
    <Base {...props}>
      <path d="m5.5 3.6 12.9 7.3-5.6 1.2-2.6 5.4L5.5 3.6Z" />
      <path d="m13.2 12.4 4.2 4.6" />
    </Base>
  );
}

export function LayersIcon(props: IconProps): React.JSX.Element {
  return (
    <Base {...props}>
      <path d="m12 3.6 8.4 4.4-8.4 4.4L3.6 8 12 3.6Z" />
      <path d="m4.6 12 7.4 3.9 7.4-3.9" />
      <path d="m4.6 16 7.4 3.9 7.4-3.9" />
    </Base>
  );
}

export function DocumentIcon(props: IconProps): React.JSX.Element {
  return (
    <Base {...props}>
      <path d="M13.5 3.5H7a2 2 0 0 0-2 2v13a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V9l-5.5-5.5Z" />
      <path d="M13.4 3.6V9h5.5" />
      <path d="M8.6 13h6.8M8.6 16.6h4.8" />
    </Base>
  );
}

export function LinkIcon(props: IconProps): React.JSX.Element {
  return (
    <Base {...props}>
      <path d="M10.4 13.6a3.6 3.6 0 0 0 5.2 0l2.4-2.4a3.7 3.7 0 0 0-5.2-5.2l-1.2 1.2" />
      <path d="M13.6 10.4a3.6 3.6 0 0 0-5.2 0L6 12.8a3.7 3.7 0 0 0 5.2 5.2l1.2-1.2" />
    </Base>
  );
}

export function FlagIcon(props: IconProps): React.JSX.Element {
  return (
    <Base {...props}>
      <path d="M6 20.5V4.5" />
      <path d="M6 5.6h10.8l-1.7 3.3 1.7 3.3H6" />
    </Base>
  );
}

export function ShieldIcon(props: IconProps): React.JSX.Element {
  return (
    <Base {...props}>
      <path d="M12 3.4 5 6.2v5.1c0 4 2.9 7.4 7 9.3 4.1-1.9 7-5.3 7-9.3V6.2L12 3.4Z" />
      <path d="m9.2 11.9 2 2 3.6-3.7" />
    </Base>
  );
}

export function MenuIcon(props: IconProps): React.JSX.Element {
  return (
    <Base {...props}>
      <path d="M4 7h16M4 12h16M4 17h16" />
    </Base>
  );
}

export function PauseIcon(props: IconProps): React.JSX.Element {
  return (
    <Base {...props}>
      <path d="M9.2 5.5v13M14.8 5.5v13" />
    </Base>
  );
}

export function TargetIcon(props: IconProps): React.JSX.Element {
  return (
    <Base {...props}>
      <circle cx="12" cy="12" r="8.4" />
      <circle cx="12" cy="12" r="4.4" />
      <circle cx="12" cy="12" r="0.9" fill="currentColor" />
    </Base>
  );
}