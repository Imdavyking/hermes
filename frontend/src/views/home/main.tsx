import React, { useState, useCallback } from "react";
import { toast } from "react-toastify";
import {
  useAccount,
  useContract,
  useReadContract,
  useSendTransaction,
} from "@starknet-react/core";
import { CallData, uint256 } from "starknet";
import { FaSpinner, FaBitcoin, FaDownload, FaUpload } from "react-icons/fa";
import { RiShieldKeyholeFill, RiEyeOffFill } from "react-icons/ri";
import abi from "../../assets/json/abi";
import { CONTRACT_ADDRESS } from "../../utils/constants";
import { poseidon2Hash } from "@zkpassport/poseidon2";

// ─── Helpers ──────────────────────────────────────────────────────────────────

function shortenAddress(addr: string) {
  if (!addr || addr.length < 10) return addr;
  const hex = addr.toString().startsWith("0x")
    ? addr
    : "0x" + BigInt(addr).toString(16);
  return `${hex.slice(0, 6)}…${hex.slice(-4)}`;
}

function formatRate8(raw: bigint): string {
  const whole = raw / 10n ** 8n;
  const frac = (raw % 10n ** 8n).toString().padStart(8, "0").slice(0, 2);
  return `${whole.toLocaleString()}.${frac}`;
}
function hexRoot(val: any): string {
  try {
    return "0x" + BigInt(val.toString()).toString(16).slice(0, 12) + "…";
  } catch {
    return "—";
  }
}

// ─── Reusable sub-components ──────────────────────────────────────────────────

function StatCard({
  label,
  value,
  highlight = false,
}: {
  label: string;
  value: React.ReactNode;
  highlight?: boolean;
}) {
  return (
    <div
      style={{
        background: "#111118",
        border: `1px solid ${highlight ? "rgba(255,200,0,0.2)" : "#1e1e2e"}`,
        borderRadius: 8,
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
        {label}
      </div>
      <div
        style={{
          fontSize: "0.82rem",
          fontWeight: 700,
          color: highlight ? "#ffc800" : "#ccc",
        }}
      >
        {value}
      </div>
    </div>
  );
}

function StepRow({
  n,
  label,
  done,
  active,
}: {
  n: number;
  label: string;
  done: boolean;
  active: boolean;
}) {
  return (
    <div
      style={{
        display: "flex",
        alignItems: "center",
        gap: "0.7rem",
      }}
    >
      <div
        style={{
          width: 24,
          height: 24,
          borderRadius: "50%",
          flexShrink: 0,
          background: done ? "#ffc800" : active ? "#111118" : "#0a0a0f",
          border: `1px solid ${done ? "#ffc800" : active ? "#2a2a3a" : "#111"}`,
          color: done ? "#0a0a0f" : active ? "#ffc800" : "#2a2a3a",
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          fontSize: "0.6rem",
          fontWeight: 900,
          fontFamily: "'DM Mono', monospace",
          transition: "all 0.25s",
        }}
      >
        {done ? "✓" : n}
      </div>
      <span
        style={{
          fontSize: "0.72rem",
          color: done ? "#ffc800" : active ? "#aaa" : "#2a2a3a",
          letterSpacing: "0.08em",
          transition: "color 0.25s",
        }}
      >
        {label}
      </span>
    </div>
  );
}

function NotePreview({
  nullifier,
  secret,
  commitment,
}: {
  nullifier: string;
  secret: string;
  commitment: string;
}) {
  return (
    <div
      style={{
        background: "#0a0a0f",
        border: "1px solid #1e1e2e",
        borderRadius: 8,
        padding: "0.85rem",
        fontFamily: "'DM Mono', monospace",
        fontSize: "0.62rem",
        color: "#2a2a3a",
        lineHeight: 1.9,
        wordBreak: "break-all",
      }}
    >
      <div>
        <span style={{ color: "#1e1e2e" }}>nullifier </span>
        <span style={{ color: "#555" }}>{nullifier.slice(0, 22)}…</span>
      </div>
      <div>
        <span style={{ color: "#1e1e2e" }}>secret&nbsp;&nbsp;&nbsp;</span>
        <span style={{ color: "#555" }}>{secret.slice(0, 22)}…</span>
      </div>
      <div>
        <span style={{ color: "#1e1e2e" }}>commit&nbsp;&nbsp;&nbsp;</span>
        <span style={{ color: "#ffc800" }}>{commitment.slice(0, 22)}…</span>
      </div>
    </div>
  );
}

// ─── Main Component ───────────────────────────────────────────────────────────

type Tab = "deposit" | "withdraw";
type DepositStep = 1 | 2 | 3 | 4;

export default function UmbraHome() {
  const { address, account } = useAccount();
  const { contract } = useContract({ abi, address: CONTRACT_ADDRESS });

  const [tab, setTab] = useState<Tab>("deposit");

  // ── Deposit state ──────────────────────────────────────────────────────────
  const [step, setStep] = useState<DepositStep>(1);
  const [nullifier, setNullifier] = useState("");
  const [secret, setSecret] = useState("");
  const [commitment, setCommitment] = useState("");
  const [noteReady, setNoteReady] = useState(false);
  const [mintLoading, setMintLoading] = useState(false);
  const [depositLoading, setDepositLoading] = useState(false);

  // ── Withdraw state ─────────────────────────────────────────────────────────
  const [withdrawNote, setWithdrawNote] = useState("");
  const [recipient, setRecipient] = useState("");
  const [withdrawLoading, setWithdrawLoading] = useState(false);
  const [withdrawError, setWithdrawError] = useState<string | null>(null);

  // ── Chain reads ────────────────────────────────────────────────────────────
  const { data: currentRoot } = useReadContract({
    abi,
    address: CONTRACT_ADDRESS,
    functionName: "current_root",
    args: [],
    watch: true,
    refetchInterval: 8000,
  });

  const { data: leafCount } = useReadContract({
    abi,
    address: CONTRACT_ADDRESS,
    functionName: "next_leaf_index",
    args: [],
    watch: true,
    refetchInterval: 8000,
  });

  const { data: btcRate } = useReadContract({
    abi,
    address: CONTRACT_ADDRESS,
    functionName: "get_btc_strk_rate",
    args: [],
    watch: true,
    refetchInterval: 30000,
  });

  const { data: btcPrice } = useReadContract({
    abi,
    address: CONTRACT_ADDRESS,
    functionName: "get_btc_usd_price",
    args: [],
    watch: true,
    refetchInterval: 30000,
  });

  // ── Derived ────────────────────────────────────────────────────────────────
  const poolDepositCount = leafCount ? Number(leafCount) : 0;
  const btcPriceDisplay = btcPrice
    ? `$${(Number((btcPrice as any)[0]) / 1e8).toLocaleString(undefined, { maximumFractionDigits: 0 })}`
    : "—";
  const payoutDisplay = btcRate
    ? `${formatRate8(BigInt((btcRate as bigint).toString()))} pSTRK`
    : "—";

  // ── Generate note ──────────────────────────────────────────────────────────
  const generateNote = useCallback(() => {
    const randHex = () =>
      "0x" +
      Array.from(crypto.getRandomValues(new Uint8Array(31)))
        .map((b) => b.toString(16).padStart(2, "0"))
        .join("");
    const n = randHex();
    const s = randHex();
    const c = "0x" + poseidon2Hash([BigInt(n), BigInt(s)]).toString(16);
    setNullifier(n);
    setSecret(s);
    setCommitment(c);
    setNoteReady(true);
    setStep(2);
  }, []);

  const downloadNote = useCallback(() => {
    const note = JSON.stringify({ nullifier, secret, commitment }, null, 2);
    const blob = new Blob([note], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `umbra-note-${Date.now()}.json`;
    a.click();
    URL.revokeObjectURL(url);
    toast.success("Note saved — keep this file safe!");
  }, [nullifier, secret, commitment]);

  // ── Mint + approve ─────────────────────────────────────────────────────────
  const handleMintApprove = async () => {
    if (!account || !contract) {
      toast.error("Connect your wallet.");
      return;
    }
    setMintLoading(true);
    try {
      // 1. mock_btc_mint
      const mintTx = await account.execute([
        contract.populate("mock_btc_mint", [address as string, 100_000_000]),
      ]);
      await account.waitForTransaction(mintTx.transaction_hash);

      // 2. approve PrivateSwap to spend pBTC
      // (call pBTC contract approve — get pbtc_address first)
      const pbtcAddress = await contract.call("pbtc_address");
      const approveTx = await account.execute([
        {
          contractAddress: pbtcAddress.toString(),
          entrypoint: "approve",
          calldata: [CONTRACT_ADDRESS, 100_000_000, 0],
        },
      ]);
      await account.waitForTransaction(approveTx.transaction_hash);
      toast.success("pBTC minted and approved!");
      setStep(3);
    } catch (err: any) {
      toast.error("Mint/approve failed: " + (err?.message ?? err));
    } finally {
      setMintLoading(false);
    }
  };

  // ── Deposit ────────────────────────────────────────────────────────────────
  const handleDeposit = async () => {
    if (!account || !contract || !commitment) return;
    setDepositLoading(true);
    try {
      const commitData = uint256.bnToUint256(BigInt(commitment!));
      const callData = CallData.compile([commitData]);

      await account.estimateInvokeFee({
        contractAddress: CONTRACT_ADDRESS,
        entrypoint: "deposit",
        calldata: callData,
      });
      const tx = await account.execute([
        contract.populate("deposit", [commitData]),
      ]);
      await account.waitForTransaction(tx.transaction_hash);
      toast.success("Deposited into Umbra pool 🛡️");
      setStep(4);
    } catch (err: any) {
      const msg =
        err?.baseError?.data?.execution_error?.error ??
        err?.message ??
        String(err);

      toast.error(msg);
    } finally {
      setDepositLoading(false);
    }
  };

  // ── Withdraw ───────────────────────────────────────────────────────────────
  const handleWithdraw = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!account || !contract) {
      toast.error("Connect your wallet.");
      return;
    }
    if (!withdrawNote.trim() || !recipient.trim()) return;
    setWithdrawError(null);
    setWithdrawLoading(true);
    try {
      const note = JSON.parse(withdrawNote);
      // TODO: compute merkle proof offchain, run Noir circuit
      // const { proof } = await generateWithdrawProof(note, currentRoot)
      const proof: bigint[] = []; // placeholder

      const tx = await account.execute([
        contract.populate("withdraw", [
          proof,
          BigInt(currentRoot as any), // current Merkle root
          note.nullifier, // nullifier_hash = hash(nullifier)
          recipient,
        ]),
      ]);
      await account.waitForTransaction(tx.transaction_hash);
      toast.success("Withdrawn! pSTRK minted to your wallet 🎉");
      setWithdrawNote("");
      setRecipient("");
    } catch (err: any) {
      const msg = err?.message ?? String(err);
      setWithdrawError(msg);
      toast.error("Withdrawal failed.");
    } finally {
      setWithdrawLoading(false);
    }
  };

  // ── Shared input style ─────────────────────────────────────────────────────
  const inputStyle: React.CSSProperties = {
    width: "100%",
    background: "#111118",
    border: "1px solid #2a2a3a",
    borderRadius: 8,
    padding: "0.9rem 1rem",
    color: "#fff",
    fontSize: "0.8rem",
    fontFamily: "'DM Mono', monospace",
    outline: "none",
    boxSizing: "border-box",
    transition: "border-color 0.2s, box-shadow 0.2s",
  };

  const btnPrimary = (enabled: boolean): React.CSSProperties => ({
    width: "100%",
    background: enabled ? "#ffc800" : "#111118",
    color: enabled ? "#0a0a0f" : "#2a2a3a",
    border: `1px solid ${enabled ? "#ffc800" : "#1e1e2e"}`,
    borderRadius: 8,
    padding: "1rem",
    fontSize: "0.85rem",
    fontFamily: "'DM Mono', monospace",
    fontWeight: 900,
    letterSpacing: "0.08em",
    cursor: enabled ? "pointer" : "not-allowed",
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    gap: "0.5rem",
    transition: "all 0.2s",
  });

  const btnGhost: React.CSSProperties = {
    width: "100%",
    background: "transparent",
    color: "#555",
    border: "1px solid #1e1e2e",
    borderRadius: 8,
    padding: "0.75rem",
    fontSize: "0.72rem",
    fontFamily: "'DM Mono', monospace",
    cursor: "pointer",
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    gap: "0.5rem",
    letterSpacing: "0.08em",
    transition: "border-color 0.2s, color 0.2s",
  };

  // ── Render ─────────────────────────────────────────────────────────────────
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
      {/* Grid background */}
      <div
        style={{
          position: "fixed",
          inset: 0,
          backgroundImage: `
            linear-gradient(rgba(255,200,0,0.025) 1px, transparent 1px),
            linear-gradient(90deg, rgba(255,200,0,0.025) 1px, transparent 1px)
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
          top: "-15%",
          left: "50%",
          transform: "translateX(-50%)",
          width: "55vw",
          height: "55vw",
          borderRadius: "50%",
          background:
            "radial-gradient(circle, rgba(255,200,0,0.045) 0%, transparent 65%)",
          pointerEvents: "none",
          zIndex: 0,
        }}
      />

      <div
        style={{
          position: "relative",
          zIndex: 1,
          maxWidth: 600,
          margin: "0 auto",
          padding: "3rem 1.5rem 6rem",
        }}
      >
        {/* ── Header ── */}
        <header style={{ textAlign: "center", marginBottom: "2.5rem" }}>
          <div
            style={{
              display: "inline-flex",
              alignItems: "center",
              gap: "0.5rem",
              fontSize: "0.65rem",
              letterSpacing: "0.25em",
              textTransform: "uppercase",
              color: "#ffc800",
              border: "1px solid rgba(255,200,0,0.22)",
              borderRadius: 2,
              padding: "0.2rem 0.75rem",
              marginBottom: "1.25rem",
            }}
          >
            <RiShieldKeyholeFill size={11} />
            Umbra · Private BTC Swap
          </div>

          <h1
            style={{
              fontSize: "clamp(2.4rem, 8vw, 4rem)",
              fontWeight: 900,
              letterSpacing: "-0.04em",
              margin: 0,
              lineHeight: 1.0,
            }}
          >
            Deposit BTC.
            <br />
            <span style={{ color: "#ffc800" }}>Vanish.</span>
          </h1>

          <p
            style={{
              color: "#3a3a4a",
              fontSize: "0.78rem",
              marginTop: "0.85rem",
              letterSpacing: "0.05em",
              lineHeight: 1.7,
            }}
          >
            ZK proof on Starknet · Poseidon2 Merkle tree · Pragma oracle rate
          </p>

          {/* Wallet badge */}
          {address && (
            <div
              style={{
                display: "inline-block",
                marginTop: "0.75rem",
                fontSize: "0.62rem",
                color: "#22c55e",
                border: "1px solid rgba(34,197,94,0.2)",
                borderRadius: 4,
                padding: "0.2rem 0.7rem",
                letterSpacing: "0.1em",
              }}
            >
              ● {shortenAddress(address)}
            </div>
          )}
        </header>

        {/* ── Stats ── */}
        <div
          style={{
            display: "grid",
            gridTemplateColumns: "1fr 1fr 1fr 1fr",
            gap: "0.6rem",
            marginBottom: "1.75rem",
          }}
        >
          <StatCard label="Pool depth" value={poolDepositCount} />
          <StatCard label="BTC/USD" value={btcPriceDisplay} highlight />
          <StatCard
            label="1 pBTC →"
            value={
              btcRate
                ? `${formatRate8(BigInt((btcRate as bigint).toString()))} STRK`
                : "—"
            }
            highlight
          />
          <StatCard
            label="Merkle root"
            value={currentRoot ? hexRoot(currentRoot) : "—"}
          />
        </div>

        {/* ── Tabs ── */}
        <div
          style={{
            display: "grid",
            gridTemplateColumns: "1fr 1fr",
            background: "#111118",
            border: "1px solid #1e1e2e",
            borderRadius: 10,
            padding: 4,
            marginBottom: "1.5rem",
          }}
        >
          {(["deposit", "withdraw"] as Tab[]).map((t) => (
            <button
              key={t}
              onClick={() => setTab(t)}
              style={{
                background: tab === t ? "#1e1e2e" : "transparent",
                color: tab === t ? "#ffc800" : "#3a3a4a",
                border:
                  tab === t ? "1px solid #2a2a3a" : "1px solid transparent",
                borderRadius: 8,
                padding: "0.7rem",
                fontSize: "0.72rem",
                fontFamily: "'DM Mono', monospace",
                fontWeight: 700,
                letterSpacing: "0.12em",
                textTransform: "uppercase",
                cursor: "pointer",
                transition: "all 0.18s",
              }}
            >
              {t === "deposit" ? "↓  Deposit" : "↑  Withdraw"}
            </button>
          ))}
        </div>

        {/* ════════════════════════════════════════════
            DEPOSIT TAB
        ════════════════════════════════════════════ */}
        {tab === "deposit" && (
          <div
            style={{ display: "flex", flexDirection: "column", gap: "1rem" }}
          >
            {/* Step progress */}
            <div
              style={{
                background: "#111118",
                border: "1px solid #1e1e2e",
                borderRadius: 10,
                padding: "1.1rem 1.25rem",
                display: "flex",
                flexDirection: "column",
                gap: "0.85rem",
              }}
            >
              <StepRow
                n={1}
                label="Generate your note (nullifier + secret)"
                done={step > 1}
                active={step === 1}
              />
              <StepRow
                n={2}
                label="Mint pBTC & approve pool"
                done={step > 2}
                active={step === 2}
              />
              <StepRow
                n={3}
                label="Deposit into Merkle tree"
                done={step > 3}
                active={step === 3}
              />
              <StepRow
                n={4}
                label="Save note for withdrawal"
                done={step === 4}
                active={step === 4}
              />
            </div>

            {/* Step 1 — Generate note */}
            {step === 1 && (
              <div
                style={{
                  background: "#111118",
                  border: "1px solid #1e1e2e",
                  borderRadius: 10,
                  padding: "1.25rem",
                }}
              >
                <div
                  style={{
                    display: "flex",
                    alignItems: "flex-start",
                    gap: "0.75rem",
                    background: "rgba(255,200,0,0.04)",
                    border: "1px solid rgba(255,200,0,0.1)",
                    borderRadius: 8,
                    padding: "0.85rem",
                    marginBottom: "1rem",
                  }}
                >
                  <RiEyeOffFill
                    size={14}
                    color="#ffc800"
                    style={{ flexShrink: 0, marginTop: 1 }}
                  />
                  <p
                    style={{
                      color: "#555",
                      fontSize: "0.68rem",
                      lineHeight: 1.75,
                      margin: 0,
                    }}
                  >
                    Your <span style={{ color: "#ffc800" }}>nullifier</span> and{" "}
                    <span style={{ color: "#ffc800" }}>secret</span> are
                    generated locally and never leave your browser. The
                    commitment hash is what goes on-chain.
                  </p>
                </div>
                <button
                  onClick={generateNote}
                  disabled={!address}
                  style={btnPrimary(!!address)}
                >
                  Generate Note
                </button>
                {!address && (
                  <p
                    style={{
                      color: "#f59e0b",
                      fontSize: "0.65rem",
                      textAlign: "center",
                      marginTop: "0.5rem",
                    }}
                  >
                    Connect wallet first
                  </p>
                )}
              </div>
            )}

            {/* Step 2 — Mint + Approve */}
            {step === 2 && noteReady && (
              <div
                style={{
                  background: "#111118",
                  border: "1px solid #1e1e2e",
                  borderRadius: 10,
                  padding: "1.25rem",
                  display: "flex",
                  flexDirection: "column",
                  gap: "0.85rem",
                }}
              >
                <NotePreview
                  nullifier={nullifier}
                  secret={secret}
                  commitment={commitment}
                />
                <button onClick={downloadNote} style={btnGhost}>
                  <FaDownload size={11} />
                  Save umbra-note.json — required to withdraw
                </button>
                <button
                  onClick={handleMintApprove}
                  disabled={mintLoading}
                  style={btnPrimary(!mintLoading)}
                >
                  {mintLoading ? (
                    <>
                      <FaSpinner
                        size={13}
                        style={{ animation: "spin 1s linear infinite" }}
                      />
                      Minting & Approving…
                    </>
                  ) : (
                    <>
                      <FaBitcoin size={13} />
                      Mint 1 pBTC & Approve
                    </>
                  )}
                </button>
              </div>
            )}

            {/* Step 3 — Deposit */}
            {step === 3 && (
              <div
                style={{
                  background: "#111118",
                  border: "1px solid #1e1e2e",
                  borderRadius: 10,
                  padding: "1.25rem",
                  display: "flex",
                  flexDirection: "column",
                  gap: "0.85rem",
                }}
              >
                <div
                  style={{
                    background: "#0a0a0f",
                    border: "1px solid #1e1e2e",
                    borderRadius: 8,
                    padding: "0.85rem",
                    display: "flex",
                    justifyContent: "space-between",
                    alignItems: "center",
                  }}
                >
                  <div>
                    <div
                      style={{
                        color: "#2a2a3a",
                        fontSize: "0.6rem",
                        letterSpacing: "0.12em",
                        textTransform: "uppercase",
                        marginBottom: "0.25rem",
                      }}
                    >
                      You send
                    </div>
                    <div
                      style={{
                        color: "#fff",
                        fontSize: "1rem",
                        fontWeight: 700,
                      }}
                    >
                      1.00 pBTC
                    </div>
                  </div>
                  <div style={{ textAlign: "right" }}>
                    <div
                      style={{
                        color: "#2a2a3a",
                        fontSize: "0.6rem",
                        letterSpacing: "0.12em",
                        textTransform: "uppercase",
                        marginBottom: "0.25rem",
                      }}
                    >
                      You receive
                    </div>
                    <div
                      style={{
                        color: "#ffc800",
                        fontSize: "1rem",
                        fontWeight: 700,
                      }}
                    >
                      {payoutDisplay}
                    </div>
                  </div>
                </div>
                <button
                  onClick={handleDeposit}
                  disabled={depositLoading}
                  style={btnPrimary(!depositLoading)}
                >
                  {depositLoading ? (
                    <>
                      <FaSpinner
                        size={13}
                        style={{ animation: "spin 1s linear infinite" }}
                      />
                      Depositing…
                    </>
                  ) : (
                    <>
                      <RiShieldKeyholeFill size={14} />
                      Deposit into Pool
                    </>
                  )}
                </button>
                <p
                  style={{
                    color: "#2a2a3a",
                    fontSize: "0.65rem",
                    textAlign: "center",
                    margin: 0,
                    letterSpacing: "0.06em",
                  }}
                >
                  Your commitment is inserted into the Merkle tree · no link to
                  your address
                </p>
              </div>
            )}

            {/* Step 4 — Done */}
            {step === 4 && (
              <div
                style={{
                  background: "rgba(255,200,0,0.04)",
                  border: "1px solid rgba(255,200,0,0.18)",
                  borderRadius: 10,
                  padding: "2rem 1.5rem",
                  textAlign: "center",
                }}
              >
                <RiShieldKeyholeFill
                  size={30}
                  color="#ffc800"
                  style={{ marginBottom: "0.85rem" }}
                />
                <div
                  style={{
                    color: "#ffc800",
                    fontWeight: 900,
                    fontSize: "1rem",
                    letterSpacing: "0.05em",
                  }}
                >
                  Deposited into Umbra
                </div>
                <div
                  style={{
                    color: "#555",
                    fontSize: "0.72rem",
                    marginTop: "0.5rem",
                    lineHeight: 1.7,
                  }}
                >
                  Your note is your key to withdraw. Use the Withdraw tab from
                  any wallet — no link will ever appear on-chain.
                </div>
                <button
                  onClick={downloadNote}
                  style={{
                    ...btnGhost,
                    marginTop: "1.25rem",
                    width: "auto",
                    padding: "0.6rem 1.25rem",
                  }}
                >
                  <FaDownload size={11} />
                  Re-download note
                </button>
              </div>
            )}
          </div>
        )}

        {/* ════════════════════════════════════════════
            WITHDRAW TAB
        ════════════════════════════════════════════ */}
        {tab === "withdraw" && (
          <form
            onSubmit={handleWithdraw}
            style={{ display: "flex", flexDirection: "column", gap: "1rem" }}
          >
            {/* Privacy notice */}
            <div
              style={{
                display: "flex",
                alignItems: "flex-start",
                gap: "0.75rem",
                background: "rgba(255,200,0,0.04)",
                border: "1px solid rgba(255,200,0,0.1)",
                borderRadius: 10,
                padding: "1rem",
              }}
            >
              <RiShieldKeyholeFill
                size={16}
                color="#ffc800"
                style={{ flexShrink: 0, marginTop: 1 }}
              />
              <div
                style={{ fontSize: "0.67rem", color: "#555", lineHeight: 1.75 }}
              >
                A <span style={{ color: "#ffc800" }}>zero-knowledge proof</span>{" "}
                is generated locally. Your nullifier and secret never leave your
                browser. The on-chain verifier only sees the Garaga proof.
              </div>
            </div>

            {/* Note input */}
            <div
              style={{
                background: "#111118",
                border: "1px solid #1e1e2e",
                borderRadius: 10,
                padding: "1.25rem",
                display: "flex",
                flexDirection: "column",
                gap: "0.65rem",
              }}
            >
              <label
                style={{
                  color: "#3a3a4a",
                  fontSize: "0.6rem",
                  letterSpacing: "0.15em",
                  textTransform: "uppercase",
                }}
              >
                Paste or upload your note
              </label>
              <textarea
                value={withdrawNote}
                onChange={(e) => setWithdrawNote(e.target.value)}
                placeholder={
                  '{ "nullifier": "0x...", "secret": "0x...", "commitment": "0x..." }'
                }
                rows={4}
                style={{
                  ...inputStyle,
                  resize: "none",
                  lineHeight: 1.7,
                  color: withdrawNote ? "#fff" : "#2a2a3a",
                  fontSize: "0.72rem",
                }}
                onFocus={(e) => {
                  e.target.style.borderColor = "#ffc800";
                  e.target.style.boxShadow = "0 0 0 2px rgba(255,200,0,0.08)";
                }}
                onBlur={(e) => {
                  e.target.style.borderColor = "#2a2a3a";
                  e.target.style.boxShadow = "none";
                }}
              />
              <label
                htmlFor="note-file"
                style={{
                  display: "flex",
                  alignItems: "center",
                  justifyContent: "center",
                  gap: "0.5rem",
                  padding: "0.65rem",
                  border: "1px dashed #1e1e2e",
                  borderRadius: 8,
                  color: "#3a3a4a",
                  fontSize: "0.68rem",
                  cursor: "pointer",
                  letterSpacing: "0.08em",
                  transition: "border-color 0.2s",
                }}
                onMouseEnter={(e) =>
                  (e.currentTarget.style.borderColor = "#555")
                }
                onMouseLeave={(e) =>
                  (e.currentTarget.style.borderColor = "#1e1e2e")
                }
              >
                <FaUpload size={10} />
                Upload umbra-note.json
                <input
                  id="note-file"
                  type="file"
                  accept=".json"
                  style={{ display: "none" }}
                  onChange={(e) => {
                    const file = e.target.files?.[0];
                    if (!file) return;
                    const reader = new FileReader();
                    reader.onload = (ev) =>
                      setWithdrawNote(ev.target?.result as string);
                    reader.readAsText(file);
                  }}
                />
              </label>
            </div>

            {/* Recipient */}
            <div
              style={{
                background: "#111118",
                border: "1px solid #1e1e2e",
                borderRadius: 10,
                padding: "1.25rem",
                display: "flex",
                flexDirection: "column",
                gap: "0.6rem",
              }}
            >
              <label
                style={{
                  color: "#3a3a4a",
                  fontSize: "0.6rem",
                  letterSpacing: "0.15em",
                  textTransform: "uppercase",
                }}
              >
                Recipient address
              </label>
              <input
                value={recipient}
                onChange={(e) => setRecipient(e.target.value)}
                placeholder="0x… (ideally a fresh wallet)"
                style={inputStyle}
                onFocus={(e) => {
                  e.target.style.borderColor = "#ffc800";
                  e.target.style.boxShadow = "0 0 0 2px rgba(255,200,0,0.08)";
                }}
                onBlur={(e) => {
                  e.target.style.borderColor = "#2a2a3a";
                  e.target.style.boxShadow = "none";
                }}
              />
              <p
                style={{
                  color: "#2a2a3a",
                  fontSize: "0.62rem",
                  margin: 0,
                  letterSpacing: "0.06em",
                }}
              >
                ↗ Use a different wallet than your deposit address for maximum
                privacy
              </p>
            </div>

            {/* Payout summary */}
            <div
              style={{
                display: "flex",
                alignItems: "center",
                justifyContent: "space-between",
                background: "rgba(255,200,0,0.04)",
                border: "1px solid rgba(255,200,0,0.14)",
                borderRadius: 10,
                padding: "1rem 1.25rem",
              }}
            >
              <div>
                <div
                  style={{
                    color: "#3a3a4a",
                    fontSize: "0.6rem",
                    letterSpacing: "0.12em",
                    textTransform: "uppercase",
                    marginBottom: "0.25rem",
                  }}
                >
                  You receive
                </div>
                <div
                  style={{
                    color: "#ffc800",
                    fontSize: "1.15rem",
                    fontWeight: 900,
                  }}
                >
                  {payoutDisplay}
                </div>
              </div>
              <div style={{ textAlign: "right" }}>
                <div
                  style={{
                    color: "#2a2a3a",
                    fontSize: "0.6rem",
                    letterSpacing: "0.1em",
                    textTransform: "uppercase",
                    marginBottom: "0.2rem",
                  }}
                >
                  via Pragma
                </div>
                <div style={{ color: "#3a3a4a", fontSize: "0.65rem" }}>
                  BTC/USD ÷ STRK/USD
                </div>
              </div>
            </div>

            {/* Error */}
            {withdrawError && (
              <div
                style={{
                  color: "#f87171",
                  background: "rgba(248,113,113,0.06)",
                  border: "1px solid rgba(248,113,113,0.18)",
                  borderRadius: 8,
                  padding: "0.85rem",
                  fontSize: "0.72rem",
                  wordBreak: "break-word",
                  lineHeight: 1.6,
                }}
              >
                {withdrawError}
              </div>
            )}

            {/* Submit */}
            {!address && (
              <div
                style={{
                  color: "#f59e0b",
                  background: "rgba(245,158,11,0.06)",
                  border: "1px solid rgba(245,158,11,0.18)",
                  borderRadius: 8,
                  padding: "0.75rem",
                  fontSize: "0.75rem",
                  textAlign: "center",
                }}
              >
                Connect your wallet to withdraw
              </div>
            )}

            <button
              type="submit"
              disabled={
                !withdrawNote.trim() ||
                !recipient.trim() ||
                withdrawLoading ||
                !address
              }
              style={btnPrimary(
                !!withdrawNote.trim() &&
                  !!recipient.trim() &&
                  !withdrawLoading &&
                  !!address,
              )}
            >
              {withdrawLoading ? (
                <>
                  <FaSpinner
                    size={13}
                    style={{ animation: "spin 1s linear infinite" }}
                  />
                  Generating ZK proof…
                </>
              ) : (
                <>
                  <RiShieldKeyholeFill size={14} />
                  Generate proof & withdraw
                </>
              )}
            </button>

            <p
              style={{
                color: "#2a2a3a",
                fontSize: "0.65rem",
                textAlign: "center",
                margin: 0,
                letterSpacing: "0.06em",
              }}
            >
              Proof generated locally · verified by Garaga on Starknet
            </p>
          </form>
        )}

        {/* ── Footer ── */}
        <footer
          style={{
            marginTop: "3.5rem",
            textAlign: "center",
            color: "#1e1e2e",
            fontSize: "0.58rem",
            letterSpacing: "0.18em",
            textTransform: "uppercase",
          }}
        >
          Umbra · Starknet Sepolia · Powered by Garaga + Pragma + Noir
        </footer>
      </div>

      <style>{`
        @import url('https://fonts.googleapis.com/css2?family=DM+Mono:ital,wght@0,300;0,400;0,500;1,300;1,400;1,500&display=swap');
        @keyframes spin { to { transform: rotate(360deg); } }
        * { box-sizing: border-box; }
        textarea, input { caret-color: #ffc800; }
        ::selection { background: rgba(255,200,0,0.18); }
        ::-webkit-scrollbar { width: 4px; }
        ::-webkit-scrollbar-track { background: #0a0a0f; }
        ::-webkit-scrollbar-thumb { background: #1e1e2e; border-radius: 2px; }
      `}</style>
    </div>
  );
}
