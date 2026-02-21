import React, { useState, useEffect, useMemo } from "react";
import { toast } from "react-toastify";
import {
  useAccount,
  useContract,
  useReadContract,
  useSendTransaction,
} from "@starknet-react/core";
import { FaSpinner, FaTrophy, FaMedal } from "react-icons/fa";
import { RiSwordFill } from "react-icons/ri";
import abi from "../../assets/json/abi";
import { CONTRACT_ADDRESS, FIELD_MODULUS } from "../../utils/constants";
import { useZkVerifier } from "../../helpers/gen_proof";
import { keccak256 } from "ethers";

// ─── Helpers ─────────────────────────────────────────────────────────────────

function shortenAddress(addr: string) {
  if (!addr || addr.length < 10) return addr;

  // Convert decimal to hex if not already 0x-prefixed
  const hex = addr.toString().startsWith("0x")
    ? addr
    : "0x" + BigInt(addr).toString(16);

  return `${hex.slice(0, 6)}…${hex.slice(-4)}`;
}

function formatTime(seconds: number) {
  if (seconds <= 0) return "00:00:00";
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = seconds % 60;
  return [h, m, s].map((v) => String(v).padStart(2, "0")).join(":");
}

// Decode felt252 short string back to ASCII
function feltToString(felt: bigint): string {
  if (!felt) return "";
  let hex = felt.toString(16);
  if (hex.length % 2 !== 0) hex = "0" + hex;
  let result = "";
  for (let i = 0; i < hex.length; i += 2) {
    const code = parseInt(hex.slice(i, i + 2), 16);
    if (code > 0) result += String.fromCharCode(code);
  }
  return result;
}

// ─── PanagramWheel ────────────────────────────────────────────────────────────

function PanagramWheel({ word }: { word: string }) {
  const letters = word.toUpperCase().split("");
  const middleIndex = Math.floor(letters.length / 2);

  if (!letters.length) return null;

  return (
    <div
      style={{
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        margin: "2rem 0",
      }}
    >
      <div style={{ position: "relative", width: 280, height: 280 }}>
        {/* Ambient glow */}
        <div
          style={{
            position: "absolute",
            inset: 0,
            borderRadius: "50%",
            background:
              "radial-gradient(circle, rgba(255,200,0,0.07) 0%, transparent 68%)",
            pointerEvents: "none",
          }}
        />

        {/* Centre letter */}
        <div
          style={{
            position: "absolute",
            left: "50%",
            top: "50%",
            transform: "translate(-50%, -50%)",
            width: 68,
            height: 68,
            borderRadius: "50%",
            background: "#ffc800",
            color: "#0a0a0f",
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            fontSize: "1.6rem",
            fontWeight: 900,
            fontFamily: "'DM Mono', monospace",
            boxShadow:
              "0 0 32px rgba(255,200,0,0.45), 0 0 8px rgba(255,200,0,0.7)",
            zIndex: 2,
            letterSpacing: "-0.05em",
            userSelect: "none",
          }}
        >
          {letters[middleIndex]}
        </div>

        {/* Surrounding letters */}
        {letters.map((letter, index) => {
          if (index === middleIndex) return null;
          const totalOuter = letters.length - 1;
          const posIndex = index < middleIndex ? index : index - 1;
          const angle = (360 / totalOuter) * posIndex - 90;
          const x = 50 + 38 * Math.cos((angle * Math.PI) / 180);
          const y = 50 + 38 * Math.sin((angle * Math.PI) / 180);

          return (
            <div
              key={index}
              style={{
                position: "absolute",
                left: `${x}%`,
                top: `${y}%`,
                transform: "translate(-50%, -50%)",
                width: 54,
                height: 54,
                borderRadius: "50%",
                background: "#111118",
                border: "1px solid #2a2a3a",
                color: "#e0e0e0",
                display: "flex",
                alignItems: "center",
                justifyContent: "center",
                fontSize: "1.15rem",
                fontWeight: 700,
                fontFamily: "'DM Mono', monospace",
                boxShadow: "0 2px 14px rgba(0,0,0,0.5)",
                userSelect: "none",
              }}
            >
              {letter}
            </div>
          );
        })}

        {/* Dashed orbit ring */}
        <svg
          style={{
            position: "absolute",
            inset: 0,
            width: "100%",
            height: "100%",
            opacity: 0.1,
          }}
          viewBox="0 0 280 280"
        >
          <circle
            cx="140"
            cy="140"
            r="106"
            fill="none"
            stroke="#ffc800"
            strokeWidth="1"
            strokeDasharray="4 8"
          />
        </svg>
      </div>
    </div>
  );
}

// ─── Countdown ────────────────────────────────────────────────────────────────

function Countdown({ startTime }: { startTime: number }) {
  const MIN_DURATION = 10800;
  const [remaining, setRemaining] = useState(0);

  useEffect(() => {
    const update = () => {
      const elapsed = Math.floor(Date.now() / 1000) - startTime;
      setRemaining(Math.max(0, MIN_DURATION - elapsed));
    };
    update();
    const id = setInterval(update, 1000);
    return () => clearInterval(id);
  }, [startTime]);

  const pct = Math.max(0, Math.min(1, remaining / MIN_DURATION));
  const r = 34;
  const circumference = 2 * Math.PI * r;

  return (
    <div
      style={{
        display: "flex",
        flexDirection: "column",
        alignItems: "center",
        gap: "0.5rem",
      }}
    >
      <div style={{ position: "relative", width: 80, height: 80 }}>
        <svg width="80" height="80" style={{ transform: "rotate(-90deg)" }}>
          <circle
            cx="40"
            cy="40"
            r={r}
            fill="none"
            stroke="#1e1e2e"
            strokeWidth="4"
          />
          <circle
            cx="40"
            cy="40"
            r={r}
            fill="none"
            stroke={remaining === 0 ? "#333" : "#ffc800"}
            strokeWidth="4"
            strokeDasharray={circumference}
            strokeDashoffset={circumference * (1 - pct)}
            strokeLinecap="round"
            style={{ transition: "stroke-dashoffset 1s linear" }}
          />
        </svg>
        <div
          style={{
            position: "absolute",
            inset: 0,
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            color: remaining === 0 ? "#444" : "#ffc800",
            fontSize: "0.55rem",
            fontFamily: "'DM Mono', monospace",
            fontWeight: 700,
            letterSpacing: "0.08em",
          }}
        >
          {remaining === 0 ? "DONE" : "LIVE"}
        </div>
      </div>
      <div
        style={{
          color: "#ccc",
          fontSize: "1.2rem",
          fontFamily: "'DM Mono', monospace",
          letterSpacing: "0.12em",
        }}
      >
        {formatTime(remaining)}
      </div>
      <div
        style={{
          color: "#3a3a4a",
          fontSize: "0.6rem",
          letterSpacing: "0.15em",
          textTransform: "uppercase",
        }}
      >
        remaining
      </div>
    </div>
  );
}

// ─── HomePage ─────────────────────────────────────────────────────────────────

export default function HomePage() {
  const { address, account } = useAccount();
  const { contract } = useContract({ abi, address: CONTRACT_ADDRESS });

  // ── Chain reads ──────────────────────────────────────────────────────────

  const { data: currentRound } = useReadContract({
    abi,
    address: CONTRACT_ADDRESS,
    functionName: "get_current_round",
    args: [],
    watch: true,
    refetchInterval: 5000,
  });

  const { data: roundStartTime } = useReadContract({
    abi,
    address: CONTRACT_ADDRESS,
    functionName: "get_round_start_time",
    args: [],
    watch: true,
    refetchInterval: 5000,
  });

  const { data: currentWinner } = useReadContract({
    abi,
    address: CONTRACT_ADDRESS,
    functionName: "get_current_round_winner",
    args: [],
    watch: true,
    refetchInterval: 5000,
  });

  const { data: lettersRaw } = useReadContract({
    abi,
    address: CONTRACT_ADDRESS,
    functionName: "get_letters",
    args: [],
    watch: true,
    refetchInterval: 5000,
  });

  const { data: lastGuessRound } = useReadContract({
    abi,
    address: CONTRACT_ADDRESS,
    functionName: "get_last_correct_guess_round",
    args: address ? [address] : undefined,
    enabled: !!address,
    watch: true,
    refetchInterval: 5000,
  });

  // ── Derived values ───────────────────────────────────────────────────────

  const roundNum = currentRound ? Number(currentRound) : 0;
  const startTimestamp = roundStartTime ? Number(roundStartTime) : 0;
  const hasWinner =
    currentWinner && currentWinner !== "0x0" && currentWinner !== "0";
  const alreadyGuessed =
    lastGuessRound && Number(lastGuessRound) === roundNum && roundNum > 0;
  const noRound = roundNum === 0;

  // Decode the on-chain felt252 short string back to ASCII letters
  const anagram = useMemo(() => {
    if (!lettersRaw) return "";
    try {
      return feltToString(BigInt(lettersRaw.toString()));
    } catch {
      return "";
    }
  }, [lettersRaw]);

  // ── Proof + guess submission ─────────────────────────────────────────────

  const [guess, setGuess] = useState("");
  const { generateProof: genProof } = useZkVerifier();
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [proof, setProof] = useState<bigint[] | null>(null);

  const generateProof = async (_guessWord: string): Promise<bigint[]> => {
    if (!account) {
      toast.error("Connect your wallet to generate the proof.");
      throw new Error("Wallet not connected");
    }

    const cleaned = _guessWord.trim().toUpperCase();
    const encoder = new TextEncoder();

    // Step 1: keccak256 the guess bytes
    const guessBytes = encoder.encode(cleaned);
    const guessHashHex = keccak256(guessBytes); // 256-bit hex

    // Step 2: reduce mod BN254 field modulus so it fits in Noir's Field type
    const guessHashField = BigInt(guessHashHex) % FIELD_MODULUS;

    // Step 3: hash it again for the public input (to prevent revealing the guess preimage on-chain)
    const doubleHash = await contract?.call("get_answer");

    // Step 4: address as field element

    const addressField = (BigInt(account?.address!) % FIELD_MODULUS).toString();

    const inputs = {
      guess_hash: "0x" + guessHashField.toString(16).padStart(64, "0"), // private — keccak(guess) mod p
      answer_double_hash: "0x" + doubleHash?.toString(16).padStart(64, "0"), // public  — from chain
      address: addressField, // public  — caller
    };

    console.log("Generating proof with inputs:", inputs);

    const { callData } = await genProof(inputs);
    return callData.slice(1);
  };

  const { sendAsync: makeGuessTx } = useSendTransaction({
    calls:
      contract && address && proof
        ? [contract.populate("make_guess", [proof])]
        : undefined,
  });

  const handleGuess = async (e: React.FormEvent) => {
    if (!account) {
      toast.error("Connect your wallet to submit a guess.");
      return;
    }
    e.preventDefault();
    if (!guess.trim() || !address) return;
    setError(null);
    setSubmitting(true);
    try {
      const generatedProof = await generateProof(guess);
      setProof(generatedProof);
      await new Promise((r) => setTimeout(r, 100));
      await account.estimateInvokeFee({
        contractAddress: CONTRACT_ADDRESS,
        entrypoint: "make_guess",
        calldata: [generatedProof],
      });
      const tx = await makeGuessTx();
      await account?.waitForTransaction(tx.transaction_hash);
      toast.success("Correct! Proof verified on-chain 🏆");
      setGuess("");
      setProof(null);
    } catch (err: any) {
      const msg = err?.message ?? String(err);
      setError(msg);
      if (msg.includes("Invalid proof") || msg.includes("InvalidProof")) {
        toast.error("Wrong answer — proof rejected.");
      } else {
        toast.error("Submission failed.");
      }
    } finally {
      setSubmitting(false);
    }
  };

  // ── Render ───────────────────────────────────────────────────────────────

  return (
    <div
      style={{
        minHeight: "100vh",
        background: "#0a0a0f",
        color: "#fff",
        fontFamily: "'DM Mono', 'Courier New', monospace",
        overflowX: "hidden",
      }}
    >
      {/* Background grid */}
      <div
        style={{
          position: "fixed",
          inset: 0,
          backgroundImage: `
            linear-gradient(rgba(255,200,0,0.03) 1px, transparent 1px),
            linear-gradient(90deg, rgba(255,200,0,0.03) 1px, transparent 1px)
          `,
          backgroundSize: "48px 48px",
          pointerEvents: "none",
          zIndex: 0,
        }}
      />
      {/* Radial bloom */}
      <div
        style={{
          position: "fixed",
          top: "-20%",
          left: "50%",
          transform: "translateX(-50%)",
          width: "60vw",
          height: "60vw",
          borderRadius: "50%",
          background:
            "radial-gradient(circle, rgba(255,200,0,0.04) 0%, transparent 65%)",
          pointerEvents: "none",
          zIndex: 0,
        }}
      />

      <div
        style={{
          position: "relative",
          zIndex: 1,
          maxWidth: 640,
          margin: "0 auto",
          padding: "3rem 1.5rem 5rem",
          display: "flex",
          flexDirection: "column",
        }}
      >
        {/* ── Page header ── */}
        <header style={{ textAlign: "center", marginBottom: "2.5rem" }}>
          <div
            style={{
              display: "inline-block",
              fontSize: "0.65rem",
              letterSpacing: "0.25em",
              textTransform: "uppercase",
              color: "#ffc800",
              border: "1px solid rgba(255,200,0,0.25)",
              borderRadius: "2px",
              padding: "0.2rem 0.75rem",
              marginBottom: "1rem",
            }}
          >
            Zygram · Round {roundNum > 0 ? `#${roundNum}` : "—"}
          </div>

          <h1
            style={{
              fontSize: "clamp(2.2rem, 7vw, 3.75rem)",
              fontWeight: 900,
              letterSpacing: "-0.04em",
              margin: 0,
              lineHeight: 1,
              color: "#fff",
            }}
          >
            Find the
            <br />
            <span style={{ color: "#ffc800" }}>Panagram</span>
          </h1>

          <p
            style={{
              color: "#555",
              fontSize: "0.8rem",
              marginTop: "0.75rem",
              letterSpacing: "0.04em",
            }}
          >
            Use every letter · Prove it on-chain · Win the NFT
          </p>
        </header>

        {/* ── No round ── */}
        {noRound && (
          <div
            style={{
              textAlign: "center",
              border: "1px dashed #1e1e2e",
              borderRadius: "12px",
              padding: "4rem 2rem",
              color: "#333",
            }}
          >
            <div style={{ fontSize: "2.5rem", marginBottom: "1rem" }}>⏳</div>
            <div style={{ fontSize: "0.9rem", color: "#444" }}>
              No active round yet.
            </div>
            <div
              style={{
                fontSize: "0.75rem",
                marginTop: "0.5rem",
                color: "#2a2a3a",
              }}
            >
              The admin will start one soon.
            </div>
          </div>
        )}

        {/* ── Active round ── */}
        {!noRound && (
          <>
            {/* Stats row */}
            <div
              style={{
                display: "grid",
                gridTemplateColumns: "1fr 1fr 1fr",
                gap: "0.75rem",
                marginBottom: "1.5rem",
              }}
            >
              {[
                {
                  label: "Round",
                  value: <span style={{ color: "#fff" }}>#{roundNum}</span>,
                },
                {
                  label: "Winner",
                  value: hasWinner ? (
                    <span
                      style={{
                        display: "flex",
                        alignItems: "center",
                        gap: "0.3rem",
                        justifyContent: "center",
                      }}
                    >
                      <FaTrophy size={10} color="#ffc800" />
                      <span style={{ color: "#ffc800" }}>
                        {shortenAddress(currentWinner as string)}
                      </span>
                    </span>
                  ) : (
                    <span style={{ color: "#22c55e" }}>Open</span>
                  ),
                },
                {
                  label: "You",
                  value: !address ? (
                    <span style={{ color: "#3a3a4a" }}>—</span>
                  ) : alreadyGuessed ? (
                    <span style={{ color: "#22c55e" }}>✓ Solved</span>
                  ) : (
                    <span style={{ color: "#ffc800" }}>Pending</span>
                  ),
                },
              ].map((stat, i) => (
                <div
                  key={i}
                  style={{
                    background: "#111118",
                    border: "1px solid #1e1e2e",
                    borderRadius: "8px",
                    padding: "0.85rem",
                    textAlign: "center",
                  }}
                >
                  <div
                    style={{
                      color: "#3a3a4a",
                      fontSize: "0.6rem",
                      letterSpacing: "0.12em",
                      textTransform: "uppercase",
                      marginBottom: "0.4rem",
                    }}
                  >
                    {stat.label}
                  </div>
                  <div style={{ fontSize: "0.8rem", fontWeight: 700 }}>
                    {stat.value}
                  </div>
                </div>
              ))}
            </div>

            {/* Countdown */}
            {startTimestamp > 0 && (
              <div
                style={{
                  display: "flex",
                  justifyContent: "center",
                  marginBottom: "0.5rem",
                }}
              >
                <Countdown startTime={startTimestamp} />
              </div>
            )}

            {/* Letter wheel — only render when letters are loaded */}
            {anagram ? (
              <PanagramWheel word={anagram} />
            ) : (
              <div
                style={{
                  display: "flex",
                  justifyContent: "center",
                  alignItems: "center",
                  height: 280,
                  color: "#2a2a3a",
                  fontSize: "0.75rem",
                }}
              >
                Loading letters…
              </div>
            )}

            <p
              style={{
                textAlign: "center",
                color: "#2a2a3a",
                fontSize: "0.65rem",
                letterSpacing: "0.08em",
                marginTop: "-1rem",
                marginBottom: "1.5rem",
              }}
            >
              Gold = centre letter · must be used · letters are shuffled
            </p>

            {/* Winner banner */}
            {hasWinner && (
              <div
                style={{
                  background: "rgba(255,200,0,0.05)",
                  border: "1px solid rgba(255,200,0,0.18)",
                  borderRadius: "10px",
                  padding: "1rem 1.25rem",
                  display: "flex",
                  alignItems: "center",
                  gap: "1rem",
                  marginBottom: "1.5rem",
                }}
              >
                <FaTrophy size={20} color="#ffc800" style={{ flexShrink: 0 }} />
                <div>
                  <div
                    style={{
                      color: "#ffc800",
                      fontSize: "0.65rem",
                      letterSpacing: "0.12em",
                      textTransform: "uppercase",
                    }}
                  >
                    Round Winner
                  </div>
                  <div
                    style={{
                      color: "#fff",
                      fontSize: "0.85rem",
                      fontWeight: 700,
                      marginTop: "0.15rem",
                      wordBreak: "break-all",
                    }}
                  >
                    {`0x${BigInt(currentWinner).toString(16)}` as string}
                  </div>
                </div>
              </div>
            )}

            {/* Already solved */}
            {alreadyGuessed ? (
              <div
                style={{
                  background: "rgba(34,197,94,0.05)",
                  border: "1px solid rgba(34,197,94,0.18)",
                  borderRadius: "10px",
                  padding: "2rem 1.5rem",
                  textAlign: "center",
                }}
              >
                <FaMedal
                  size={28}
                  color="#22c55e"
                  style={{ marginBottom: "0.75rem" }}
                />
                <div
                  style={{
                    color: "#22c55e",
                    fontWeight: 700,
                    letterSpacing: "0.05em",
                    fontSize: "0.95rem",
                  }}
                >
                  You solved this round!
                </div>
                <div
                  style={{
                    fontSize: "0.75rem",
                    color: "#166534",
                    marginTop: "0.4rem",
                  }}
                >
                  Check your wallet for the NFT reward.
                </div>
              </div>
            ) : (
              /* Guess form */
              <form
                onSubmit={handleGuess}
                style={{
                  display: "flex",
                  flexDirection: "column",
                  gap: "1rem",
                }}
              >
                <div>
                  <label
                    style={{
                      display: "block",
                      color: "#444",
                      fontSize: "0.65rem",
                      letterSpacing: "0.15em",
                      textTransform: "uppercase",
                      marginBottom: "0.5rem",
                    }}
                  >
                    Your Answer
                  </label>
                  <input
                    value={guess}
                    onChange={(e) => setGuess(e.target.value.toUpperCase())}
                    placeholder="TYPE YOUR ANSWER…"
                    maxLength={31}
                    disabled={submitting || !address}
                    style={{
                      width: "100%",
                      background: "#111118",
                      border: "1px solid #2a2a3a",
                      borderRadius: "8px",
                      padding: "1rem",
                      color: "#fff",
                      fontSize: "1.3rem",
                      fontFamily: "'DM Mono', monospace",
                      fontWeight: 700,
                      letterSpacing: "0.2em",
                      outline: "none",
                      boxSizing: "border-box",
                      textAlign: "center",
                      transition: "border-color 0.2s, box-shadow 0.2s",
                    }}
                    onFocus={(e) => {
                      e.target.style.borderColor = "#ffc800";
                      e.target.style.boxShadow =
                        "0 0 0 2px rgba(255,200,0,0.1)";
                    }}
                    onBlur={(e) => {
                      e.target.style.borderColor = "#2a2a3a";
                      e.target.style.boxShadow = "none";
                    }}
                  />
                </div>

                {!address && (
                  <div
                    style={{
                      color: "#f59e0b",
                      background: "rgba(245,158,11,0.06)",
                      border: "1px solid rgba(245,158,11,0.18)",
                      borderRadius: "8px",
                      padding: "0.75rem",
                      fontSize: "0.8rem",
                      textAlign: "center",
                    }}
                  >
                    Connect your wallet to submit a guess
                  </div>
                )}

                {error && (
                  <div
                    style={{
                      color: "#f87171",
                      background: "rgba(248,113,113,0.06)",
                      border: "1px solid rgba(248,113,113,0.18)",
                      borderRadius: "8px",
                      padding: "0.75rem",
                      fontSize: "0.75rem",
                      wordBreak: "break-word",
                    }}
                  >
                    {error}
                  </div>
                )}

                <button
                  type="submit"
                  disabled={!guess.trim() || !address || submitting}
                  style={{
                    background:
                      guess.trim() && address && !submitting
                        ? "#ffc800"
                        : "#111118",
                    color:
                      guess.trim() && address && !submitting
                        ? "#0a0a0f"
                        : "#2a2a3a",
                    border: "1px solid",
                    borderColor:
                      guess.trim() && address && !submitting
                        ? "#ffc800"
                        : "#1e1e2e",
                    borderRadius: "8px",
                    padding: "1rem",
                    fontSize: "0.9rem",
                    fontFamily: "'DM Mono', monospace",
                    fontWeight: 900,
                    letterSpacing: "0.1em",
                    cursor:
                      guess.trim() && address && !submitting
                        ? "pointer"
                        : "not-allowed",
                    display: "flex",
                    alignItems: "center",
                    justifyContent: "center",
                    gap: "0.5rem",
                    transition: "all 0.2s",
                  }}
                >
                  {submitting ? (
                    <>
                      <FaSpinner
                        size={14}
                        style={{ animation: "spin 1s linear infinite" }}
                      />
                      Generating proof…
                    </>
                  ) : (
                    <>
                      <RiSwordFill size={14} />
                      Submit & Prove
                    </>
                  )}
                </button>

                <p
                  style={{
                    color: "#2a2a3a",
                    fontSize: "0.65rem",
                    textAlign: "center",
                    letterSpacing: "0.06em",
                    margin: 0,
                  }}
                >
                  ZK proof generated locally · your answer is never revealed
                  on-chain
                </p>
              </form>
            )}
          </>
        )}
      </div>

      <style>{`
        @import url('https://fonts.googleapis.com/css2?family=DM+Mono:wght@400;500;700;900&display=swap');
        @keyframes spin { to { transform: rotate(360deg); } }
      `}</style>
    </div>
  );
}
