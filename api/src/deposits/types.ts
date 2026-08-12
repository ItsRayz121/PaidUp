// Shared shape between chain adapters (deposits/adapters/*.ts) and the single
// crediting path (deposits/credit.ts) that consumes whatever they find. An
// adapter's whole job is turning "a chain's own idea of a payment" into this.
export type ObservedDeposit = {
  userId: string;
  chain: string;
  address: string;
  txHash: string;
  // NULL for chains with no "which event in this tx" concept. EVM/TRON always
  // set this (a tx can carry several Transfer events to different addresses).
  logIndex: number | null;
  amountMicro: bigint;
  token: string;
  blockNumber: number;
  blockHash: string;
};

// A plain native-value (BNB) transfer, found by deposits/adapters/evmNative.ts.
// Deliberately its own shape, not a variant of ObservedDeposit: there is no
// token contract, no log/log_index, and — unlike ObservedDeposit — this NEVER
// reaches a ledger-crediting path (see native_deposits' table comment in
// db.ts). Keeping the types distinct makes it harder to accidentally pass one
// where the other is expected.
export type ObservedNativeDeposit = {
  userId: string;
  chain: string;
  address: string;
  txHash: string;
  fromAddress: string;
  amountWei: bigint;
  blockNumber: number;
  blockHash: string;
};
