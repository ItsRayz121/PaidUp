// Functional UI icons only (nav, status, actions). Inline SVG, currentColor.
// Every icon is aria-hidden and ALWAYS shown next to a text label — meaning is
// never carried by an icon alone (DESIGN_BRIEF.md accessibility floor). Brand /
// marketing icon art comes from Canva, not from here.
import type { SVGProps } from "react";

type IconProps = SVGProps<SVGSVGElement> & { size?: number };

function base({ size = 24, ...props }: IconProps) {
  return {
    width: size,
    height: size,
    viewBox: "0 0 24 24",
    fill: "none",
    stroke: "currentColor",
    strokeWidth: 2,
    strokeLinecap: "round" as const,
    strokeLinejoin: "round" as const,
    "aria-hidden": true,
    focusable: false,
    ...props,
  };
}

export const HomeIcon = (p: IconProps) => (
  <svg {...base(p)}><path d="M3 10.5 12 3l9 7.5" /><path d="M5 9.5V21h14V9.5" /></svg>
);
export const TasksIcon = (p: IconProps) => (
  <svg {...base(p)}><path d="M9 6h11M9 12h11M9 18h11" /><path d="M4 6h.01M4 12h.01M4 18h.01" /></svg>
);
export const WalletIcon = (p: IconProps) => (
  <svg {...base(p)}><rect x="3" y="6" width="18" height="13" rx="2.5" /><path d="M3 10h18" /><circle cx="16.5" cy="14" r="1.2" /></svg>
);
export const ReferIcon = (p: IconProps) => (
  <svg {...base(p)}><circle cx="9" cy="8" r="3.2" /><path d="M3.5 20a5.5 5.5 0 0 1 11 0" /><path d="M17 8h4M19 6v4" /></svg>
);
export const VideoIcon = (p: IconProps) => (
  <svg {...base(p)}><rect x="3" y="6" width="13" height="12" rx="2.5" /><path d="m21 8-5 4 5 4V8Z" /></svg>
);
export const InstallIcon = (p: IconProps) => (
  <svg {...base(p)}><path d="M12 3v11" /><path d="m8 11 4 4 4-4" /><path d="M5 20h14" /></svg>
);
export const SurveyIcon = (p: IconProps) => (
  <svg {...base(p)}><rect x="5" y="3" width="14" height="18" rx="2.5" /><path d="M9 8h6M9 12h6M9 16h3" /></svg>
);
export const CheckIcon = (p: IconProps) => (
  <svg {...base(p)}><path d="m5 12.5 4.5 4.5L19 7" /></svg>
);
export const ClockIcon = (p: IconProps) => (
  <svg {...base(p)}><circle cx="12" cy="12" r="9" /><path d="M12 7v5l3 2" /></svg>
);
export const XIcon = (p: IconProps) => (
  <svg {...base(p)}><path d="M6 6l12 12M18 6 6 18" /></svg>
);
export const ArrowRightIcon = (p: IconProps) => (
  <svg {...base(p)}><path d="M5 12h14" /><path d="m13 6 6 6-6 6" /></svg>
);
export const GiftIcon = (p: IconProps) => (
  <svg {...base(p)}><rect x="3.5" y="9" width="17" height="12" rx="2" /><path d="M12 9v12M3.5 13h17" /><path d="M12 9C9 9 7.5 4 12 4c4.5 0 3 5 0 5Z" /></svg>
);
export const ShareIcon = (p: IconProps) => (
  <svg {...base(p)}><circle cx="6" cy="12" r="2.5" /><circle cx="18" cy="6" r="2.5" /><circle cx="18" cy="18" r="2.5" /><path d="m8.2 10.8 7.6-3.6M8.2 13.2l7.6 3.6" /></svg>
);
export const CopyIcon = (p: IconProps) => (
  <svg {...base(p)}><rect x="9" y="9" width="12" height="12" rx="2" /><path d="M5 15V5a2 2 0 0 1 2-2h10" /></svg>
);
export const ShieldIcon = (p: IconProps) => (
  <svg {...base(p)}><path d="M12 3 5 6v6c0 4 3 6.5 7 9 4-2.5 7-5 7-9V6l-7-3Z" /></svg>
);
export const StarIcon = (p: IconProps) => (
  <svg {...base(p)}><path d="M12 3.5 14.6 9l6 .8-4.4 4.2 1.1 6L12 17.8 6.7 20l1.1-6L3.4 9.8l6-.8L12 3.5Z" /></svg>
);
export const InfoIcon = (p: IconProps) => (
  <svg {...base(p)}><circle cx="12" cy="12" r="9" /><path d="M12 11v5" /><path d="M12 7.5h.01" /></svg>
);

export const HelpIcon = (p: IconProps) => (
  <svg {...base(p)}><circle cx="12" cy="12" r="9" /><path d="M9.5 9.5a2.5 2.5 0 1 1 3.5 2.3c-.8.4-1 .9-1 1.7" /><path d="M12 17h.01" /></svg>
);
export const ChartIcon = (p: IconProps) => (
  <svg {...base(p)}><path d="M4 20V4" /><path d="M4 20h16" /><rect x="7" y="11" width="3" height="6" /><rect x="12.5" y="7" width="3" height="10" /><rect x="18" y="13" width="3" height="4" /></svg>
);
export const SlidersIcon = (p: IconProps) => (
  <svg {...base(p)}><path d="M4 6h10M18 6h2M4 12h4M12 12h8M4 18h12M18 18h2" /><circle cx="16" cy="6" r="2" /><circle cx="10" cy="12" r="2" /><circle cx="16" cy="18" r="2" /></svg>
);
export const InboxIcon = (p: IconProps) => (
  <svg {...base(p)}><path d="M4 13h4l2 3h4l2-3h4" /><path d="M5 13 6.5 5h11L19 13v5a1 1 0 0 1-1 1H6a1 1 0 0 1-1-1v-5Z" /></svg>
);

// ---- Mining (ROZI) --------------------------------------------------------
export const MineIcon = (p: IconProps) => (
  <svg {...base(p)}><path d="m14 3 7 7-4 4-7-7 4-4Z" /><path d="m10.5 6.5-7.5 12 12-7.5" /><path d="M3 21h.01" /></svg>
);
export const ChipIcon = (p: IconProps) => (
  <svg {...base(p)}><rect x="7" y="7" width="10" height="10" rx="1.5" /><path d="M10 2v3M14 2v3M10 19v3M14 19v3M2 10h3M2 14h3M19 10h3M19 14h3" /></svg>
);
export const FlameIcon = (p: IconProps) => (
  <svg {...base(p)}><path d="M12 3s5 4 5 8a5 5 0 0 1-10 0c0-1.5.8-2.8 1.5-3.5C9 9 10 10 10 11c0-2 1-6 2-8Z" /></svg>
);
export const BoltIcon = (p: IconProps) => (
  <svg {...base(p)}><path d="M13 2 4 14h7l-1 8 9-12h-7l1-8Z" /></svg>
);
export const LockIcon = (p: IconProps) => (
  <svg {...base(p)}><rect x="4" y="10" width="16" height="11" rx="2" /><path d="M8 10V7a4 4 0 0 1 8 0v3" /></svg>
);

export const offerIcon = { install: InstallIcon, video: VideoIcon, survey: SurveyIcon, custom: StarIcon };

// Rig art, keyed by the `icon` column on the rigs table (Admin-editable). Falls
// back to the chip so a rig with an unknown icon name still renders.
export const rigIcon: Record<string, (p: IconProps) => React.ReactElement> = {
  phone: (p) => <svg {...base(p)}><rect x="7" y="2" width="10" height="20" rx="2" /><path d="M11 18h2" /></svg>,
  laptop: (p) => <svg {...base(p)}><rect x="3" y="5" width="18" height="11" rx="1.5" /><path d="M2 19h20" /></svg>,
  chip: ChipIcon,
  server: (p) => <svg {...base(p)}><rect x="3" y="4" width="18" height="6" rx="1.5" /><rect x="3" y="14" width="18" height="6" rx="1.5" /><path d="M7 7h.01M7 17h.01" /></svg>,
  building: (p) => <svg {...base(p)}><path d="M3 21V7l6-4v18" /><path d="M9 21V9l12 4v8" /><path d="M13 21v-4h4v4" /></svg>,
};
