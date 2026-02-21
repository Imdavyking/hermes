export const ProofState = {
  Initial: "Initial",
  GeneratingWitness: "Generating witness",
  GeneratingProof: "Generating proof",
  PreparingCalldata: "Preparing calldata",
  ConnectingWallet: "Connecting wallet",
  SendingTransaction: "Sending transaction",
  ProofVerified: "Proof is verified",
} as const;

export type ProofState = (typeof ProofState)[keyof typeof ProofState];

export interface ProofStateData {
  state: ProofState;
  error?: string;
}
