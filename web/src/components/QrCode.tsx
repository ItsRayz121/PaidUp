"use client";

// A deposit address as a scannable code. Client-side only (`qrcode` npm
// package, no network call) — a deposit address is money-adjacent text, and
// generating it locally means it never leaves the browser to render.
import { useEffect, useState } from "react";
import QRCode from "qrcode";

export function QrCode({ value, size = 176 }: { value: string; size?: number }) {
  const [svg, setSvg] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    QRCode.toString(value, { type: "svg", margin: 1, width: size }, (err, str) => {
      if (alive && !err) setSvg(str);
    });
    return () => { alive = false; };
  }, [value, size]);

  if (!svg) {
    return <div className="grid place-items-center rounded-xl bg-brand-tint" style={{ width: size, height: size }} />;
  }
  // The content is a QR encoding of `value` (an address WE fetched from our
  // own API), not user-typed input — nothing here renders untrusted HTML.
  return <div className="rounded-xl bg-white p-2" style={{ width: size, height: size }} dangerouslySetInnerHTML={{ __html: svg }} />;
}
