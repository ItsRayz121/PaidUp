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
