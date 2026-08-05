// Real crypto token marks — filled, brand-coloured, for the wallet's token
// list. Deliberately separate from icons.tsx: that file is outline-only,
// currentColor, functional UI icons ("brand / marketing icon art comes from
// Canva, not from here"). A token logo is neither — it identifies a specific
// coin, the way a bank app shows a Visa or Mastercard mark, so it needs its
// own fixed colours regardless of theme.
import type { SVGProps } from "react";

type LogoProps = SVGProps<SVGSVGElement> & { size?: number };

// Tether (USDT) — teal circle, white "T" mark.
export const UsdtLogo = ({ size = 24, ...props }: LogoProps) => (
  <svg width={size} height={size} viewBox="0 0 32 32" aria-hidden focusable={false} {...props}>
    <circle cx="16" cy="16" r="16" fill="#26A17B" />
    <path
      fill="#fff"
      d="M17.5 17.35v-.01c-.11.01-.68.04-1.94.04-1.01 0-1.72-.03-1.97-.04v.02c-3.24-.14-5.66-.71-5.66-1.39 0-.68 2.42-1.25 5.66-1.39v2.22c.25.02.98.06 1.99.06 1.2 0 1.81-.05 1.92-.06v-2.21c3.23.14 5.64.71 5.64 1.38 0 .68-2.41 1.25-5.64 1.38Zm0-3.01v-1.98h4.51V9.5H10.02v2.86h4.51v1.98c-3.67.17-6.43.9-6.43 1.77 0 .87 2.76 1.6 6.43 1.77v6.35h2.97v-6.35c3.66-.17 6.42-.9 6.42-1.77 0-.87-2.76-1.6-6.42-1.77Z"
    />
  </svg>
);

// BNB — yellow rounded square, white diamond mark.
export const BnbLogo = ({ size = 24, ...props }: LogoProps) => (
  <svg width={size} height={size} viewBox="0 0 32 32" aria-hidden focusable={false} {...props}>
    <circle cx="16" cy="16" r="16" fill="#F0B90B" />
    <g fill="#fff">
      <path d="m12.4 14.2 3.6-3.6 3.6 3.6 2.1-2.1L16 6.4l-5.7 5.7Z" />
      <path d="m6.4 16 2.1-2.1L10.6 16l-2.1 2.1Z" />
      <path d="m12.4 17.8 3.6 3.6 3.6-3.6 2.1 2.1L16 25.6l-5.7-5.7Z" />
      <path d="m21.4 16 2.1-2.1 2.1 2.1-2.1 2.1Z" />
      <path d="m16 13.9 2.1 2.1-2.1 2.1-2.1-2.1Z" />
    </g>
  </svg>
);

// ROZI — muted outline, deliberately not a full brand mark: this row shows
// "Coming soon", never a balance, so it should not draw the eye the way the
// two real logos do (see the comment on the ROZI row in wallet/page.tsx).
export const RoziMark = ({ size = 24, ...props }: LogoProps) => (
  <svg width={size} height={size} viewBox="0 0 32 32" aria-hidden focusable={false} {...props}>
    <circle cx="16" cy="16" r="15" fill="none" stroke="currentColor" strokeWidth="2" strokeDasharray="3 3" />
    <path d="M16 10.5v11M12 13.5h5.2a2.3 2.3 0 0 1 0 4.6H12M14.5 18.1l3.5 3.4" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
  </svg>
);
