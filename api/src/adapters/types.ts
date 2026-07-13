// Every ad network implements this same interface so adding network #5 never
// touches #1–4 (docs/ARCHITECTURE.md § Ad network adapters).
export type PostbackInput = Record<string, string>;

// Extra request context a network may need to verify a postback (e.g. an IP
// allowlist). Optional for adapters that don't care.
export type PostbackContext = { ip?: string };

export type VerifiedCompletion = {
  userId: string; // our user id (network echoes it back as sub_id / ext_user_id)
  externalId: string; // network's unique completion id — used for idempotency

  // FIXED-CATALOG networks (offerhub / tapvid / surveyx): the completion maps to
  // one of our own tasks, and the reward comes from THAT task row — never from
  // the network payload.
  taskId?: string;

  // DYNAMIC-AMOUNT networks (real survey walls like CPX): there is no task row —
  // each survey pays a different amount, which arrives inside the SIGNED
  // postback. Safe to trust only because (a) the signature is verified with our
  // secret and (b) the completion id is idempotent, so a captured postback can't
  // be replayed with a bigger number. Adapters must also sanity-cap this.
  points?: number;
  offerType?: string; // e.g. "survey" — used by the per-type velocity cap

  // The network is REVERSING a completion it previously credited (CPX calls the
  // postback again with status=2 when a survey is later judged fraudulent).
  // We write a compensating debit; the original credit is never deleted.
  reversal?: boolean;
};

export type VerifyResult =
  | { ok: true; data: VerifiedCompletion }
  | { ok: false; reason: string };

export interface AdNetworkAdapter {
  name: string;
  // Verify the signature/token per THIS network's method. For fixed-catalog
  // networks, never trust the point value from the network — points come from
  // our own tasks table.
  //
  // May be async: the `custom` adapter keys each task off its OWN secret, which
  // it has to read from the database. Every other adapter verifies against a
  // single env-var secret and simply returns synchronously; the caller awaits
  // either shape.
  verifyPostback(input: PostbackInput, ctx: PostbackContext): VerifyResult | Promise<VerifyResult>;
}
