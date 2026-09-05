// JSON-RPC over a LIST of endpoints, with failover (founder, 2026-08-01).
//
// Why a list rather than one URL: the endpoints in config.payoutRpc default to
// PUBLIC nodes, which rate-limit without warning and go down without notice.
// One public endpoint is a single point of failure; several with failover is a
// working system at small volume. A paid endpoint, when there is one, goes
// FIRST in the list and the public ones become the fallback.
//
// ⚠️ WHAT THIS IS NOT. This is a read client for small, occasional lookups —
// "does this transaction exist", "what block are we on". It is NOT a substitute
// for a paid provider behind a chain listener that must never miss a deposit
// (docs/CUSTODY_SPEC.md § 4). A public node dropping a request here surfaces as
// an error a human retries; a public node dropping a block under a listener
// surfaces as a user who paid us and was never credited, silently. Those are
// different risks and only one of them is acceptable on free infrastructure.
import { config } from "./config.ts";
import { charge, CostCeilingError } from "./costGuard.ts";

export class RpcError extends Error {
  constructor(message: string, readonly attempts: { url: string; reason: string }[] = []) {
    super(message);
    this.name = "RpcError";
  }
}

// A JSON-RPC error returned BY the node (bad params, unknown method) is a real
// answer, not a broken endpoint — retrying it on four more nodes just gets the
// same answer four more times, slowly. Only transport-level failures fail over.
type JsonRpcResponse = { result?: unknown; error?: { code: number; message: string } };

// ⚠️ A PROVIDER QUOTA/RATE-LIMIT REFUSAL IS NOT "THE CHAIN'S REAL ANSWER",
// EVEN THOUGH IT ARRIVES AS A WELL-FORMED JSON-RPC ERROR OBJECT. Found
// 2026-09-05 when NodeReal's free monthly quota ran out: it returns
// {"code":-32005,"message":"...monthly quota limit..."} — same shape as a
// genuine protocol error like "bad params" — and the rule above sent it
// straight to the caller with the other five configured endpoints (Alchemy,
// public nodes) never tried. That is not "one endpoint is briefly the wrong
// choice", it is "every RPC-backed feature on this chain is fully broken
// until the quota resets", with a working failover list sitting unused right
// next to it. -32005 is "Limit exceeded" per EIP-1474 (the Ethereum JSON-RPC
// spec) and is what NodeReal, Alchemy and Infura all use for this; the
// message-keyword check covers the same shape from a provider that doesn't
// follow that convention. Genuine protocol errors ("method not found", bad
// params) do not match either check and still fail fast, unretried, as before.
//
// ⚠️ AN EARLIER VERSION OF THIS ALSO LISTED -32029 AS A "THROTTLE" CODE. IT IS
// NOT ONE — that code is an MCP (Model Context Protocol) tool-rate-limit
// convention, a completely different protocol, included here on an unverified
// guess. Removed after checking; don't add a numeric code back without a real
// source. An unverified code here is worse than none: it would silently
// reclassify some future genuine chain error as "just try the next endpoint"
// instead of surfacing it.
const PROVIDER_THROTTLE_CODES = new Set([-32005]);
const PROVIDER_THROTTLE_MESSAGE = /quota|rate.?limit|too many requests|capacity|throttl/i;
function isProviderThrottle(error: { code: number; message: string }): boolean {
  return PROVIDER_THROTTLE_CODES.has(error.code) || PROVIDER_THROTTLE_MESSAGE.test(error.message);
}

const DEFAULT_TIMEOUT_MS = 8_000;

export function endpointsFor(chain: string): string[] {
  return config.payoutRpc[chain] ?? [];
}

/**
 * Call a JSON-RPC method, trying each configured endpoint in order.
 *
 * Fails over on: network error, timeout, HTTP 429, HTTP 5xx, unparseable body,
 * and a provider quota/rate-limit refusal (see isProviderThrottle above).
 * Does NOT fail over on any other well-formed JSON-RPC error object — that is
 * the chain's real answer and every other endpoint will give the same one.
 */
export async function rpcCall(
  chain: string,
  method: string,
  params: unknown[] = [],
  opts: { timeoutMs?: number; priority?: "low" | "high" } = {},
): Promise<unknown> {
  const urls = endpointsFor(chain);
  if (!urls.length) {
    throw new RpcError(`No RPC endpoint is configured for ${chain}.`);
  }

  const priority = opts.priority ?? "low";
  const attempts: { url: string; reason: string }[] = [];

  for (const url of urls) {
    // Charged PER ATTEMPT, not per call: a failover across five endpoints is
    // five requests a provider can bill for, and the whole point of a ceiling
    // is that it counts what actually leaves the process. Refusal ends the
    // loop rather than skipping one endpoint — every attempt would be refused
    // for the same reason, and trying anyway is how a budget becomes advice.
    if (!charge("rpc", 1, priority)) {
      // NOT an RpcError: the chain is fine and nothing was tried. The retry
      // loops in payoutRelay.ts / bnbWithdraw.ts check for this type and do
      // not spend an attempt on it — see CostCeilingError's own comment.
      throw new CostCeilingError(
        `${method} not attempted: this process has reached its hourly RPC ceiling ` +
        `(RPC_MAX_CALLS_PER_HOUR). See costGuard.ts.`,
      );
    }
    // Each endpoint gets its own timeout. A shared deadline across the whole
    // list would mean one slow node eats the budget for all the healthy ones
    // behind it — which is precisely the failure failover exists to survive.
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), opts.timeoutMs ?? DEFAULT_TIMEOUT_MS);
    try {
      const res = await fetch(url, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
        signal: ac.signal,
      });

      if (res.status === 429 || res.status >= 500) {
        attempts.push({ url, reason: `HTTP ${res.status}` });
        continue;
      }
      if (!res.ok) {
        // A 4xx that is not rate limiting is usually us (a malformed body, a
        // blocked key). Record it and move on rather than declaring the whole
        // chain unreachable off one endpoint's opinion.
        attempts.push({ url, reason: `HTTP ${res.status}` });
        continue;
      }

      let body: JsonRpcResponse;
      try {
        body = (await res.json()) as JsonRpcResponse;
      } catch {
        attempts.push({ url, reason: "response was not JSON" });
        continue;
      }

      if (body.error) {
        if (isProviderThrottle(body.error)) {
          // This provider is refusing on quota/rate-limit grounds, not
          // answering the chain — try the next configured endpoint.
          attempts.push({ url, reason: `provider throttled: ${body.error.message}` });
          continue;
        }
        // A genuine protocol answer (bad params, unknown method). Every other
        // endpoint would say the same thing — do not retry.
        throw new RpcError(`${method} failed: ${body.error.message}`, attempts);
      }
      return body.result ?? null;
    } catch (e) {
      if (e instanceof RpcError) throw e; // a real answer, already decided above
      attempts.push({ url, reason: (e as Error)?.name === "AbortError" ? "timed out" : String((e as Error)?.message ?? e) });
    } finally {
      clearTimeout(timer);
    }
  }

  throw new RpcError(
    `All ${urls.length} RPC endpoints for ${chain} failed for ${method}.`,
    attempts,
  );
}

// Ping every configured endpoint independently and report which ones answer.
// Used by the staff diagnostics so an operator can SEE their RPC list working
// rather than discovering a dead list at the moment they need it.
export async function rpcHealth(chain: string): Promise<{
  url: string; ok: boolean; blockNumber?: number; reason?: string;
}[]> {
  const urls = endpointsFor(chain);
  // Counted against the ceiling like everything else: this pings EVERY endpoint,
  // so a staff member holding down refresh really does spend. Refused rather
  // than silently uncounted — a diagnostic that quietly exempts itself from the
  // meter it is displaying would be the one place the number is wrong.
  if (urls.length && !charge("rpc", urls.length, "low")) {
    return urls.map((url) => ({
      url, ok: false,
      reason: "not checked: this process has reached its hourly RPC ceiling (RPC_MAX_CALLS_PER_HOUR)",
    }));
  }
  return Promise.all(urls.map(async (url) => {
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), 5_000);
    try {
      const res = await fetch(url, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "eth_blockNumber", params: [] }),
        signal: ac.signal,
      });
      if (!res.ok) return { url, ok: false, reason: `HTTP ${res.status}` };
      const body = (await res.json()) as JsonRpcResponse;
      if (body.error) return { url, ok: false, reason: body.error.message };
      return { url, ok: true, blockNumber: Number(body.result) };
    } catch (e) {
      return { url, ok: false, reason: (e as Error)?.name === "AbortError" ? "timed out" : String((e as Error)?.message ?? e) };
    } finally {
      clearTimeout(timer);
    }
  }));
}
