import React, { useState, useMemo } from "react";
import { toast } from "react-toastify";
import {
  useAccount,
  useContract,
  useSendTransaction,
} from "@starknet-react/core";
import {
  FaSpinner,
  FaLock,
  FaEye,
  FaEyeSlash,
  FaShuffle,
} from "react-icons/fa6";
import { CallData, uint256 } from "starknet";
import abi from "../../assets/json/abi";
import { CONTRACT_ADDRESS, FIELD_MODULUS } from "../../utils/constants";
import { keccak256 } from "ethers";

// ─── Helpers ─────────────────────────────────────────────────────────────────

// Double-hash the answer to produce the on-chain commitment
function hashAnswer(answer: string): string {
  const encoder = new TextEncoder();

  // ✅ lowercase — must match player side
  const cleaned = answer.trim().toUpperCase();

  // Step 1: keccak256(answer_utf8_bytes)
  const firstHex = keccak256(encoder.encode(cleaned));

  // Step 2: reduce mod BN254 — this is guess_hash in the circuit
  const firstReduced = BigInt(firstHex) % FIELD_MODULUS;

  // Step 3: pack to 32 big-endian bytes — matches Noir's field.to_be_bytes()
  const firstBytes = new Uint8Array(32);
  let tmp = firstReduced;
  for (let i = 31; i >= 0; i--) {
    firstBytes[i] = Number(tmp & 0xffn);
    tmp >>= 8n;
  }

  // Step 4: keccak256(field_bytes) — matches circuit: keccak256(guess_hash.to_be_bytes())
  const doubledHex = keccak256(firstBytes);
  const doubledReduced = BigInt(doubledHex) % FIELD_MODULUS;

  return doubledReduced.toString(); // decimal felt252 → stored on-chain as s_answer
}

// Shuffle a word for display — admin controls what players see
function scrambleWord(word: string): string {
  const upper = word.trim().toUpperCase().split("");
  for (let i = upper.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [upper[i], upper[j]] = [upper[j], upper[i]];
  }
  return upper.join("");
}

// Pack ASCII string into felt252 big-endian
function stringToFelt(str: string): string {
  let result = BigInt(0);
  for (let i = 0; i < str.length; i++) {
    result = (result << BigInt(8)) + BigInt(str.charCodeAt(i));
  }
  return result.toString();
}

// ─── Component ───────────────────────────────────────────────────────────────

export default function NewRoundPage() {
  const { address, account } = useAccount();
  const { contract } = useContract({ abi, address: CONTRACT_ADDRESS });

  const [answer, setAnswer] = useState("");
  const [showAnswer, setShowAnswer] = useState(false);
  const [shuffled, setShuffled] = useState("");
  const [commitment, setCommitment] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Recompute commitment whenever answer changes
  const computedCommitment = useMemo(() => {
    if (!answer.trim()) return null;
    try {
      return hashAnswer(answer);
    } catch {
      return null;
    }
  }, [answer]);

  // The felt252 representation of the shuffled display word
  const lettersAsFelt = useMemo(() => {
    if (!shuffled) return null;
    try {
      return stringToFelt(shuffled);
    } catch {
      return null;
    }
  }, [shuffled]);

  // Generate a new shuffle
  const handleShuffle = () => {
    if (!answer.trim()) return;
    setShuffled(scrambleWord(answer));
  };

  // Reset commitment when answer changes
  const handleAnswerChange = (val: string) => {
    setAnswer(val);
    setCommitment(null);
    setShuffled(scrambleWord(val)); // auto-shuffle on change
  };

  const { sendAsync: newRoundTx } = useSendTransaction({
    calls:
      contract && address && computedCommitment && lettersAsFelt
        ? [
            contract.populate("new_round", [
              uint256.bnToUint256(BigInt(computedCommitment!)),
              lettersAsFelt,
            ]),
          ]
        : undefined,
  });

  const canSubmit =
    !!answer.trim() &&
    !!computedCommitment &&
    !!lettersAsFelt &&
    !!commitment &&
    commitment === computedCommitment &&
    !submitting;

  const handleCommit = () => {
    if (!computedCommitment) return;
    setCommitment(computedCommitment);
    toast.success("Answer committed! Review then submit.");
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!account) {
      toast.error("Connect your wallet first.");
      return;
    }
    setError(null);
    setSubmitting(true);
    try {
      if (!newRoundTx) throw new Error("Contract not ready");

      const s_answer = uint256.bnToUint256(BigInt(computedCommitment!));
      const callData = CallData.compile([s_answer, lettersAsFelt!]);

      console.log([BigInt(computedCommitment!), lettersAsFelt!]);

      await account.estimateInvokeFee({
        contractAddress: CONTRACT_ADDRESS,
        entrypoint: "new_round",
        calldata: callData,
      });
      const tx = await newRoundTx();
      await account.waitForTransaction(tx.transaction_hash);
      toast.success("New round started on-chain!");
      setAnswer("");
      setShuffled("");
      setCommitment(null);
    } catch (err: any) {
      const msg =
        err?.baseError?.data?.execution_error?.error ??
        err?.message ??
        String(err);
      setError(msg);
      toast.error("Transaction failed");
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div
      style={{
        minHeight: "100vh",
        background: "#0a0a0f",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        padding: "2rem",
        fontFamily: "'DM Mono', 'Courier New', monospace",
      }}
    >
      {/* Background grid */}
      <div
        style={{
          position: "fixed",
          inset: 0,
          backgroundImage: `
            linear-gradient(rgba(255,200,0,0.04) 1px, transparent 1px),
            linear-gradient(90deg, rgba(255,200,0,0.04) 1px, transparent 1px)
          `,
          backgroundSize: "48px 48px",
          pointerEvents: "none",
          zIndex: 0,
        }}
      />

      <div
        style={{
          width: "100%",
          maxWidth: 520,
          position: "relative",
          zIndex: 1,
        }}
      >
        {/* Header */}
        <div style={{ marginBottom: "2rem" }}>
          <div
            style={{
              display: "inline-flex",
              alignItems: "center",
              gap: "0.5rem",
              background: "rgba(255,200,0,0.1)",
              border: "1px solid rgba(255,200,0,0.3)",
              borderRadius: "4px",
              padding: "0.25rem 0.75rem",
              marginBottom: "1rem",
            }}
          >
            <span
              style={{
                color: "#ffc800",
                fontSize: "0.7rem",
                letterSpacing: "0.15em",
                textTransform: "uppercase",
              }}
            >
              Admin
            </span>
          </div>
          <h1
            style={{
              color: "#fff",
              fontSize: "2rem",
              fontWeight: 900,
              margin: 0,
              letterSpacing: "-0.03em",
            }}
          >
            New Round
          </h1>
          <p
            style={{ color: "#555", margin: "0.5rem 0 0", fontSize: "0.8rem" }}
          >
            Set the answer hash and shuffled letters for players.
          </p>
        </div>

        {/* Card */}
        <form
          onSubmit={handleSubmit}
          style={{
            background: "#111118",
            border: "1px solid #222230",
            borderRadius: "12px",
            padding: "2rem",
            display: "flex",
            flexDirection: "column",
            gap: "1.5rem",
          }}
        >
          {/* ── Answer input ── */}
          <div>
            <label
              style={{
                display: "block",
                color: "#888",
                fontSize: "0.7rem",
                letterSpacing: "0.1em",
                textTransform: "uppercase",
                marginBottom: "0.5rem",
              }}
            >
              Secret Answer
            </label>
            <div style={{ position: "relative" }}>
              <input
                type={showAnswer ? "text" : "password"}
                value={answer}
                onChange={(e) =>
                  handleAnswerChange(e.target.value.toUpperCase())
                }
                placeholder="type the panagram..."
                style={{
                  width: "100%",
                  background: "#0a0a0f",
                  border: "1px solid #2a2a3a",
                  borderRadius: "8px",
                  padding: "0.85rem 2.75rem 0.85rem 1rem",
                  color: "#fff",
                  fontSize: "1rem",
                  fontFamily: "inherit",
                  outline: "none",
                  boxSizing: "border-box",
                  transition: "border-color 0.2s",
                  letterSpacing: "0.05em",
                }}
                onFocus={(e) => (e.target.style.borderColor = "#ffc800")}
                onBlur={(e) => (e.target.style.borderColor = "#2a2a3a")}
              />
              <button
                type="button"
                onClick={() => setShowAnswer((v) => !v)}
                style={{
                  position: "absolute",
                  right: "0.75rem",
                  top: "50%",
                  transform: "translateY(-50%)",
                  background: "none",
                  border: "none",
                  color: "#555",
                  cursor: "pointer",
                  padding: "0.25rem",
                  display: "flex",
                  alignItems: "center",
                }}
              >
                {showAnswer ? <FaEyeSlash size={14} /> : <FaEye size={14} />}
              </button>
            </div>
            <p
              style={{ color: "#444", fontSize: "0.7rem", marginTop: "0.4rem" }}
            >
              Stored as a double-hash — plaintext never goes on-chain. Casing
              does not matter.
            </p>
          </div>

          {/* ── Shuffled letters preview ── */}
          {shuffled && (
            <div
              style={{
                background: "#0a0a0f",
                border: "1px solid #1e1e2e",
                borderRadius: "8px",
                padding: "1.25rem",
              }}
            >
              <div
                style={{
                  display: "flex",
                  alignItems: "center",
                  justifyContent: "space-between",
                  marginBottom: "0.75rem",
                }}
              >
                <span
                  style={{
                    color: "#555",
                    fontSize: "0.65rem",
                    letterSpacing: "0.1em",
                    textTransform: "uppercase",
                  }}
                >
                  Players will see
                </span>
                <button
                  type="button"
                  onClick={handleShuffle}
                  style={{
                    display: "flex",
                    alignItems: "center",
                    gap: "0.35rem",
                    background: "transparent",
                    border: "1px solid #2a2a3a",
                    borderRadius: "6px",
                    color: "#666",
                    cursor: "pointer",
                    padding: "0.25rem 0.6rem",
                    fontSize: "0.65rem",
                    fontFamily: "inherit",
                    letterSpacing: "0.06em",
                    textTransform: "uppercase",
                    transition: "border-color 0.2s, color 0.2s",
                  }}
                  onMouseEnter={(e) => {
                    (e.currentTarget as HTMLElement).style.borderColor =
                      "#ffc800";
                    (e.currentTarget as HTMLElement).style.color = "#ffc800";
                  }}
                  onMouseLeave={(e) => {
                    (e.currentTarget as HTMLElement).style.borderColor =
                      "#2a2a3a";
                    (e.currentTarget as HTMLElement).style.color = "#666";
                  }}
                >
                  <FaShuffle size={10} /> Reshuffle
                </button>
              </div>

              {/* Letter tiles */}
              <div
                style={{
                  display: "flex",
                  gap: "0.5rem",
                  flexWrap: "wrap",
                  justifyContent: "center",
                }}
              >
                {shuffled.split("").map((letter, i) => {
                  const midIdx = Math.floor(shuffled.length / 2);
                  const isCenter = i === midIdx;
                  return (
                    <div
                      key={i}
                      style={{
                        width: 44,
                        height: 44,
                        borderRadius: "50%",
                        background: isCenter ? "#ffc800" : "#111118",
                        border: isCenter ? "none" : "1px solid #2a2a3a",
                        color: isCenter ? "#0a0a0f" : "#e0e0e0",
                        display: "flex",
                        alignItems: "center",
                        justifyContent: "center",
                        fontSize: "1rem",
                        fontWeight: 900,
                        boxShadow: isCenter
                          ? "0 0 16px rgba(255,200,0,0.3)"
                          : "none",
                      }}
                    >
                      {letter}
                    </div>
                  );
                })}
              </div>
              <p
                style={{
                  color: "#333",
                  fontSize: "0.65rem",
                  textAlign: "center",
                  margin: "0.75rem 0 0",
                  letterSpacing: "0.06em",
                }}
              >
                Gold = centre letter · must be used in the answer
              </p>
            </div>
          )}

          {/* ── Commitment preview ── */}
          {computedCommitment && (
            <div
              style={{
                background: "#0a0a0f",
                border: "1px solid #1e1e2e",
                borderRadius: "8px",
                padding: "1rem",
              }}
            >
              <div
                style={{
                  color: "#555",
                  fontSize: "0.65rem",
                  letterSpacing: "0.1em",
                  textTransform: "uppercase",
                  marginBottom: "0.5rem",
                }}
              >
                On-chain commitment (felt252)
              </div>
              <div
                style={{
                  color: "#ffc800",
                  fontSize: "0.7rem",
                  wordBreak: "break-all",
                  lineHeight: 1.6,
                }}
              >
                {computedCommitment}
              </div>
            </div>
          )}

          {/* ── Confirm commitment ── */}
          {computedCommitment && commitment !== computedCommitment && (
            <button
              type="button"
              onClick={handleCommit}
              style={{
                display: "flex",
                alignItems: "center",
                justifyContent: "center",
                gap: "0.5rem",
                background: "transparent",
                border: "1px solid #ffc800",
                borderRadius: "8px",
                color: "#ffc800",
                padding: "0.75rem",
                cursor: "pointer",
                fontSize: "0.85rem",
                fontFamily: "inherit",
                letterSpacing: "0.05em",
                transition: "background 0.2s",
              }}
              onMouseEnter={(e) =>
                ((e.currentTarget as HTMLElement).style.background =
                  "rgba(255,200,0,0.08)")
              }
              onMouseLeave={(e) =>
                ((e.currentTarget as HTMLElement).style.background =
                  "transparent")
              }
            >
              <FaLock size={12} />
              Confirm Commitment
            </button>
          )}

          {/* ── Confirmed badge ── */}
          {commitment && commitment === computedCommitment && (
            <div
              style={{
                display: "flex",
                alignItems: "center",
                gap: "0.5rem",
                color: "#22c55e",
                fontSize: "0.8rem",
                background: "rgba(34,197,94,0.08)",
                border: "1px solid rgba(34,197,94,0.2)",
                borderRadius: "8px",
                padding: "0.6rem 1rem",
              }}
            >
              <span>✓</span>
              <span>Commitment confirmed — ready to submit</span>
            </div>
          )}

          {/* ── Wallet warning ── */}
          {!address && (
            <div
              style={{
                color: "#f59e0b",
                background: "rgba(245,158,11,0.08)",
                border: "1px solid rgba(245,158,11,0.2)",
                borderRadius: "8px",
                padding: "0.75rem 1rem",
                fontSize: "0.8rem",
              }}
            >
              ⚠️ Connect your wallet to start a new round.
            </div>
          )}

          {/* ── Submit ── */}
          <button
            type="submit"
            disabled={!canSubmit}
            style={{
              background: canSubmit ? "#ffc800" : "#1a1a2a",
              color: canSubmit ? "#0a0a0f" : "#333",
              border: "none",
              borderRadius: "8px",
              padding: "0.9rem",
              fontSize: "0.9rem",
              fontFamily: "inherit",
              fontWeight: 900,
              letterSpacing: "0.06em",
              cursor: canSubmit ? "pointer" : "not-allowed",
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              gap: "0.5rem",
              transition: "background 0.2s, color 0.2s",
            }}
          >
            {submitting ? (
              <>
                <FaSpinner
                  size={14}
                  style={{ animation: "spin 1s linear infinite" }}
                />{" "}
                Submitting…
              </>
            ) : (
              "Start Round On-Chain →"
            )}
          </button>

          {/* ── Error ── */}
          {error && (
            <div
              style={{
                color: "#f87171",
                background: "rgba(248,113,113,0.08)",
                border: "1px solid rgba(248,113,113,0.2)",
                borderRadius: "8px",
                padding: "0.75rem 1rem",
                fontSize: "0.75rem",
                wordBreak: "break-word",
              }}
            >
              {error}
            </div>
          )}
        </form>

        <p
          style={{
            color: "#2a2a3a",
            fontSize: "0.7rem",
            textAlign: "center",
            marginTop: "1.5rem",
            letterSpacing: "0.08em",
          }}
        >
          ZYGRAM · ADMIN PANEL · STARKNET
        </p>
      </div>

      <style>{`
        @import url('https://fonts.googleapis.com/css2?family=DM+Mono:wght@400;500;700;900&display=swap');
        @keyframes spin { to { transform: rotate(360deg); } }
      `}</style>
    </div>
  );
}
