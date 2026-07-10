// Every ad network implements this same interface so adding network #4 never
// touches #1–3 (docs/ARCHITECTURE.md § Ad network adapters).
export type PostbackInput = Record<string, string>;

export type VerifiedCompletion = {
  userId: string; // our user id (network echoes it back as sub_id)
  taskId: string; // our task id (mapped from the network's offer id)
  externalId: string; // network's unique completion id — used for idempotency
};

export type VerifyResult =
  | { ok: true; data: VerifiedCompletion }
  | { ok: false; reason: string };

export interface AdNetworkAdapter {
  name: string;
  // Verify the signature/token per THIS network's method. Never trust the
  // point value from the network — points come from our own tasks table.
  verifyPostback(input: PostbackInput): VerifyResult;
}
