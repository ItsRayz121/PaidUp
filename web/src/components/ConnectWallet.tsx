"use client";

import { useState } from "react";
import { Card, Button } from "@/components/ui";
import { WalletIcon, CheckIcon, ShieldIcon, InfoIcon } from "@/components/icons";
import { useI18n } from "@/lib/i18n";
import { requestWalletChallenge, verifyWalletSignature } from "@/lib/api";
import {
  connectWallet, signMessage, useHasWallet, walletDeepLinks, shortAddress, WalletError,
} from "@/lib/wallet";
import { chainLabel, type ChainId } from "@/lib/chains";

// "Connect wallet" — the replacement for a box the user pasted 42 characters
// into, and the reason it is worth a whole component:
//
// A pasted address proves nothing. The most common way money is stolen from
// users in our markets is a stranger on WhatsApp who says they are support and
// gives them an address to "verify" against — every check we can run on a
// string passes, we send, and it is gone with no way back. Connecting cannot be
// tricked the same way: the wallet signs, so only an address the user actually
// holds the key to can be saved.
//
// ⚠️ PASTING IS STILL ALLOWED, and removing it would break real users. A
// smart-contract wallet cannot sign this kind of message at all, an exchange
// deposit address has no signer the user controls, and plenty of phones have no
// wallet app. Connecting is the default and the safe path; typing is the door
// that must stay open beside it.
export function ConnectWallet({
  chain,
  savedAddress,
  verified,
  onConnected,
  onUseTyping,
}: {
  chain: ChainId;
  savedAddress?: string;
  verified?: boolean;
  /** Fires with the proved address, so the parent can fill the withdraw form. */
  onConnected: (address: string) => void;
  /** Reveals the paste-an-address field. */
  onUseTyping: () => void;
}) {
  const { t } = useI18n();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Whether this browser has a wallet in it — read through the store hook, not
  // during render, because `window.ethereum` does not exist on the server.
  const walletPresent = useHasWallet();
  // Set only if the provider vanishes between the check above and the tap (an
  // extension being disabled mid-session). Rare, but the alternative is a
  // button that silently does nothing.
  const [lostWallet, setLostWallet] = useState(false);
  const noWallet = !walletPresent || lostWallet;

  async function connect() {
    setBusy(true); setError(null); setLostWallet(false);
    try {
      // 1. Which account is the wallet offering? Opens the wallet's own sheet,
      //    which is why this runs straight off the tap with no await before it.
      const address = await connectWallet();
      // 2. The server decides what gets signed. If the browser made up the
      //    message, a phishing site could hand us one it collected elsewhere.
      const { nonce, message } = await requestWalletChallenge(chain, address);
      // 3. The wallet signs; the server recovers the address from the signature
      //    and saves that, never the one we sent up in step 2.
      const signature = await signMessage(address, message);
      const res = await verifyWalletSignature(nonce, signature);
      onConnected(res.address);
    } catch (e) {
      if (e instanceof WalletError) {
        if (e.cancelled) { setBusy(false); return; } // they tapped Reject: not an error
        if (e.message === "no-wallet") { setLostWallet(true); setBusy(false); return; }
      }
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  const links = noWallet ? walletDeepLinks() : null;

  return (
    <Card className="p-4">
      <p className="flex items-center gap-2 font-bold text-brand-ink">
        <WalletIcon size={20} className="shrink-0 text-brand" />
        {t("connect.title")}
      </p>

      {savedAddress ? (
        <div className="mt-3 rounded-xl border border-line bg-brand-tint/40 p-3">
          <p className="text-xs text-muted">{t("connect.savedLabel", { label: chainLabel(chain) })}</p>
          <p className="num mt-0.5 break-all font-semibold text-brand-ink">{shortAddress(savedAddress)}</p>
          {/* The badge is only ever shown for an address that was actually
              signed for. An address that was typed says so plainly instead of
              showing nothing — silence beside a green tick on a sibling row
              reads as "still loading", not as "unproven". */}
          {verified ? (
            <p className="mt-1.5 flex items-center gap-1.5 text-sm font-semibold text-success">
              <CheckIcon size={16} /> {t("connect.isYours")}
            </p>
          ) : (
            <p className="mt-1.5 flex items-start gap-1.5 text-sm text-muted">
              <InfoIcon size={16} className="mt-0.5 shrink-0" /> {t("connect.typedIn")}
            </p>
          )}
        </div>
      ) : (
        <p className="mt-1 text-sm text-muted">{t("connect.body")}</p>
      )}

      {error && <p className="mt-3 rounded-xl bg-danger-tint p-3 text-sm text-danger">{error}</p>}

      {links ? (
        // No wallet in THIS browser. Very common in our market: the wallet app
        // is installed, but the user is in Chrome, where nothing is injected.
        // Reopening the page inside the wallet's own browser is the fix, and it
        // is one tap — far better than telling them to go and find the address.
        <div className="mt-3 space-y-2.5">
          <p className="flex gap-2 rounded-xl bg-pending-tint p-3 text-sm text-pending">
            <InfoIcon size={18} className="mt-0.5 shrink-0" />
            {t("connect.noWallet")}
          </p>
          <a href={links.metamask} className="block">
            <Button variant="ghost">{t("connect.openMetamask")}</Button>
          </a>
          <a href={links.trust} className="block">
            <Button variant="ghost">{t("connect.openTrust")}</Button>
          </a>
        </div>
      ) : (
        <div className="mt-3">
          <Button variant="primary" onClick={connect} disabled={busy}>
            <WalletIcon size={20} />
            {busy ? t("connect.working") : savedAddress ? t("connect.change") : t("connect.cta")}
          </Button>
        </div>
      )}

      <p className="mt-2.5 flex items-start gap-1.5 text-xs text-muted">
        <ShieldIcon size={14} className="mt-0.5 shrink-0" />
        {t("connect.safety")}
      </p>

      <button
        type="button"
        onClick={onUseTyping}
        className="mt-3 text-sm font-semibold text-brand underline-offset-2 hover:underline"
      >
        {t("connect.typeInstead")}
      </button>
    </Card>
  );
}
