import type { AdNetworkAdapter } from "./types.ts";
import { offerhubAdapter } from "./offerhub.ts";

const registry: Record<string, AdNetworkAdapter> = {
  [offerhubAdapter.name]: offerhubAdapter,
  // Add network #2, #3 here — one line each, no changes to the others.
};

export function getAdapter(network: string): AdNetworkAdapter | undefined {
  return registry[network];
}
