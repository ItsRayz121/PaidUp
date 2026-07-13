import type { AdNetworkAdapter } from "./types.ts";
import { offerhubAdapter } from "./offerhub.ts";
import { tapvidAdapter } from "./tapvid.ts";
import { surveyxAdapter } from "./surveyx.ts";
import { cpxAdapter } from "./cpx.ts";
import { customAdapter } from "./custom.ts";

const registry: Record<string, AdNetworkAdapter> = {
  [offerhubAdapter.name]: offerhubAdapter,
  [tapvidAdapter.name]: tapvidAdapter,
  [surveyxAdapter.name]: surveyxAdapter,
  [cpxAdapter.name]: cpxAdapter, // CPX Research — the first REAL (live) network.
  [customAdapter.name]: customAdapter, // Our OWN tasks. Secret is per task, not per network.
  // Add the next network here — one line each, no changes to the others.
};

export function getAdapter(network: string): AdNetworkAdapter | undefined {
  return registry[network];
}
