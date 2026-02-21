// import { poseidon2Hash } from "@zkpassport/poseidon2";
// import { PublicKey } from "paillier-bigint";
// import { merkleTree } from "./merkle_tree";
// import * as bcu from "bigint-crypto-utils";
// import { toU1024Limbs } from "@/utils/helpers";

// // -------------------------------------------------------
// // Helpers
// // -------------------------------------------------------


// const getRandomR = (n: bigint) => {
//   let r = 0n;
//   do {
//     r = bcu.randBetween(n);
//   } while (bcu.gcd(r, n) !== 1n);
//   return r;
// };

// // -------------------------------------------------------
// // Main witness builder
// // -------------------------------------------------------

// export async function buildVoteWitness({
//   secret, // voter's secret — keep private, never share
//   allCommitments, // string[] — all registered voter commitments in the tree
//   voteFor, // true = YES [1,0], false = NO [0,1]
//   pollId,
//   pubKey, // Paillier PublicKey
// }: {
//   secret: string;
//   allCommitments: string[];
//   voteFor: boolean;
//   pollId: number;
//   pubKey: PublicKey;
// }) {
//   // 1. Derive commitment from secret: hash(secret)
//   const commitment = await poseidonHash([secret]);

//   // 2. Build Merkle tree and get proof
//   const tree = await merkleTree(allCommitments);
//   const leafIndex = tree.getIndex(commitment);
//   if (leafIndex === -1) throw new Error("Commitment not found in tree");

//   const { root, pathElements, pathIndices } = tree.proof(leafIndex);

//   // convert pathIndices → is_even for Noir
//   // pathIndices: 0 = current is left child → is_even = true
//   const is_even: boolean[] = pathIndices.map((i) => i === 0);

//   // 3. Derive nullifier: hash(secret, 0)
//   const nullifier = await poseidonHash([secret, "0"]);

//   // 4. Vote vector
//   const voteVector: [bigint, bigint] = voteFor ? [1n, 0n] : [0n, 1n];

//   // 5. Generate fresh randomness r for each element, encrypt with same r
//   const r: [bigint, bigint] = [getRandomR(pubKey.n), getRandomR(pubKey.n)];

//   // gcd check — r must be coprime with n
//   // (your existing paillier lib likely does this, replicate here)
//   const encryptedVote = voteVector.map((v, i) => pubKey.encrypt(v, r[i]));
//   // -------------------------------------------------------
//   // Noir witness — field names must match your main() exactly
//   // -------------------------------------------------------
//   const witness = {
//     // private
//     secret,
//     merkle_proof: pathElements,
//     is_even,
//     vote: voteVector.map((v) => v.toString()), // Field in Noir

//     // private U1024 — encryption randomness
//     r: r.map((_r) => toU1024Limbs(_r)),

//     // public
//     poll_id: pollId,
//     root,
//     nullifier,
//     pk_g: toU1024Limbs(pubKey.g),
//     pk_n: toU1024Limbs(pubKey.n),
//     pk_n2: toU1024Limbs(pubKey._n2),
//     // public — one ciphertext per vote element
//     enc_vote: encryptedVote.map((enc) => toU1024Limbs(enc)),
//   };

//   // enc_vote goes on-chain (submit to contract)
//   // r stays in witness only — never sent anywhere
//   return {
//     witness,
//     encryptedVote, // forward to contract call
//     nullifier, // forward to contract call
//     root, // forward to contract call
//   };
// }
