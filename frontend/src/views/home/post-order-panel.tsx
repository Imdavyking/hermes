import React, { useState, useCallback } from "react";
import { toast } from "react-toastify";
import { useAccount, useContract, useReadContract } from "@starknet-react/core";
import { hash } from "starknet";
import { FaSpinner, FaDownload, FaUpload } from "react-icons/fa";
import { RiShieldKeyholeFill, RiTimeLine } from "react-icons/ri";
import { poseidon2Hash } from "@zkpassport/poseidon2";
import abi from "../../assets/json/abi";
import { CONTRACT_ADDRESS } from "../../utils/constants";
import { merkleTree } from "../../helpers/merkle_tree";
import { useZkVerifier } from "../../helpers/gen_proof";
import { useIndexerDeposits } from "../../helpers/use_indexer_deposits";
import {
  btnPrimary,
  btnGhost,
  inputStyle,
  type CommitmentData,
} from "./shared";
import { assertReceiptSuccess } from "../../utils/helpers";

interface PostOrderPanelProps {
  onOrderPosted?: (orderId: string) => void;
}

const SLIPPAGE_PRESETS = [
  { label: "0.1%", bps: 10 },
  { label: "0.5%", bps: 50 },
  { label: "1%", bps: 100 },
  { label: "2%", bps: 200 },
  { label: "5%", bps: 500 },
];

const EXPIRY_PRESETS = [
  { label: "2h", secs: 7200 },
  { label: "6h", secs: 21600 },
  { label: "12h", secs: 43200 },
  { label: "24h", secs: 86400 },
];

export default function PostOrderPanel({ onOrderPosted }: PostOrderPanelProps) {
  const { address, account } = useAccount();
  const { contract } = useContract({ abi, address: CONTRACT_ADDRESS });
  const { generateProof } = useZkVerifier();
  const { fetchAllCommitments } = useIndexerDeposits(); // ← replaces provider.getEvents

  const [noteJson, setNoteJson] = useState("");
  const [strkDestination, setStrkDestination] = useState("");
  const [slippageBps, setSlippageBps] = useState(100);
  const [customSlippage, setCustomSlippage] = useState("");
  const [expirySeconds, setExpirySeconds] = useState(21600);
  const [swapSecret, setSwapSecret] = useState("");
  const [swapHashlock, setSwapHashlock] = useState("");
  const [secretReady, setSecretReady] = useState(false);
  const [loading, setLoading] = useState(false);
  const [step, setStep] = useState<1 | 2 | 3>(1);

  const { data: quotedStrkRaw } = useReadContract({
    abi,
    address: CONTRACT_ADDRESS,
    functionName: "get_quoted_strk_amount",
    args: [],
    watch: true,
    refetchInterval: 30000,
  });

  const quotedStrk = quotedStrkRaw
    ? `${(Number(quotedStrkRaw as bigint) / 1e18).toLocaleString(undefined, { maximumFractionDigits: 8 })} STRK`
    : "—";

  const { data: wbtcDenom } = useReadContract({
    abi,
    address: CONTRACT_ADDRESS,
    functionName: "wBTC_denomination",
    args: [],
  });

  const denomDisplay = wbtcDenom
    ? `${(Number(wbtcDenom as bigint) / 1e8).toLocaleString(undefined, { maximumFractionDigits: 8 })}wBTC`
    : "—";

  const generateSwapSecret = useCallback(() => {
    const randHex = () =>
      "0x" +
      Array.from(crypto.getRandomValues(new Uint8Array(31)))
        .map((b) => b.toString(16).padStart(2, "0"))
        .join("");
    const s = randHex();
    const hl = hash.computePedersenHash("0x0", s);

    setSwapSecret(s);
    setSwapHashlock(hl);
    setSecretReady(true);
  }, []);

  const downloadSwapNote = useCallback(() => {
    const note = JSON.stringify(
      { swapSecret, swapHashlock, role: "alice-wbtc-seller" },
      null,
      2,
    );
    const blob = new Blob([note], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `umbra-swap-secret-${Date.now()}.json`;
    a.click();
    URL.revokeObjectURL(url);
    toast.success(
      "Swap secret saved — Bob cannot take your STRK without this!",
    );
  }, [swapSecret, swapHashlock]);

  const handlePost = async () => {
    if (!account || !contract) return toast.error("Connect your wallet.");
    if (!noteJson.trim()) return toast.error("Upload your deposit note.");
    if (!strkDestination.trim())
      return toast.error("Enter STRK destination address.");
    if (!secretReady) return toast.error("Generate your swap secret first.");

    setLoading(true);
    try {
      const note: CommitmentData = JSON.parse(noteJson);

      // ── Indexer replaces provider.getEvents for Deposit ──────────────────
      const commitments = await fetchAllCommitments();
      // ─────────────────────────────────────────────────────────────────────

      const noteCommitment = BigInt(note.commitment).toString();
      const tree = await merkleTree(commitments);
      const leafIndex = tree.getIndex(noteCommitment);
      if (leafIndex === -1)
        throw new Error("Commitment not found in deposit events.");

      const merkleProof = tree.proof(leafIndex);
      const nullifierHash =
        "0x" + poseidon2Hash([BigInt(note.nullifier)]).toString(16);
      const recipientHash =
        "0x" + poseidon2Hash([BigInt(strkDestination)]).toString(16);

      const noirInput = {
        root: merkleProof.root.toString(),
        nullifier_hash: nullifierHash,
        recipient: strkDestination,
        recipient_hash: recipientHash,
        nullifier: note.nullifier,
        secret: note.secret,
        merkle_proof: merkleProof.pathElements.map((el: any) => el.toString()),
        is_even: merkleProof.pathIndices.map((el: any) => el % 2 === 0),
      };

      const toastId = toast.loading("Generating ZK proof…");
      const { callData } = await generateProof(noirInput, (msg: string) => {
        toast.update(toastId, { render: msg });
      });
      toast.update(toastId, {
        render: "Submitting order…",
        isLoading: false,
        type: "success",
      });
      toast.dismiss(toastId);
      const now = Math.floor(Date.now() / 1000);
      const expiry = now + expirySeconds;
      const slippage = customSlippage ? parseInt(customSlippage) : slippageBps;

      const populate = contract.populate("post_wbtc_order", [
        callData.slice(1),
        strkDestination,
        swapHashlock,
        expiry,
        slippage,
      ]);
      await account.estimateInvokeFee([populate]);
      const tx = await account.execute([populate]);

      const receipt = await account.waitForTransaction(tx.transaction_hash);
      assertReceiptSuccess(receipt);
      toast.success("Order posted! Share your hashlock with Bob.");
      setStep(3);
      onOrderPosted?.(swapHashlock);
    } catch (err: any) {
      const executionError =
        err?.baseError?.data?.execution_error?.error ??
        err?.message ??
        String(err);
      toast.error(executionError);
    } finally {
      setLoading(false);
    }
  };

  const effectiveSlippage = customSlippage
    ? parseInt(customSlippage)
    : slippageBps;
  const isValid =
    noteJson.trim() && strkDestination.trim() && secretReady && address;

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: "1rem" }}>
      {/* Header info */}
      <div style={infoBox}>
        <RiShieldKeyholeFill
          size={14}
          color="#ffc800"
          style={{ flexShrink: 0, marginTop: 2 }}
        />
        <div style={{ fontSize: "0.68rem", color: "#555", lineHeight: 1.8 }}>
          Post an open order: lock your wBTC anonymously. Bob fills by sending
          STRK. You reveal the secret to claim STRK — Bob sees it and takes the
          wBTC.
          <span
            style={{ color: "#ffc800", display: "block", marginTop: "0.3rem" }}
          >
            This is a Hash Time-Lock Contract (HTLC) — trustless, atomic swap.
          </span>
        </div>
      </div>

      {/* Rate preview */}
      <div style={rateBox}>
        <div>
          <div style={labelStyle}>You give</div>
          <div style={{ color: "#fff", fontSize: "1.1rem", fontWeight: 900 }}>
            {denomDisplay}
          </div>
        </div>
        <div style={{ color: "#3a3a4a", fontSize: "1.5rem" }}>→</div>
        <div style={{ textAlign: "right" }}>
          <div style={labelStyle}>Quoted STRK</div>
          <div
            style={{ color: "#ffc800", fontSize: "1.1rem", fontWeight: 900 }}
          >
            {quotedStrk}
          </div>
        </div>
      </div>

      {/* Step 1: Deposit note */}
      <Section title="1. Your deposit note (ZK proof source)">
        <textarea
          value={noteJson}
          onChange={(e) => setNoteJson(e.target.value)}
          placeholder='{"nullifier":"0x...","secret":"0x...","commitment":"0x..."}'
          rows={3}
          style={{
            ...inputStyle,
            resize: "none",
            fontSize: "0.7rem",
            lineHeight: 1.7,
          }}
        />
        <label
          htmlFor="alice-note"
          style={uploadLabel}
          onMouseEnter={(e) => (e.currentTarget.style.borderColor = "#555")}
          onMouseLeave={(e) => (e.currentTarget.style.borderColor = "#1e1e2e")}
        >
          <FaUpload size={10} /> Upload umbra-note.json
          <input
            id="alice-note"
            type="file"
            accept=".json"
            style={{ display: "none" }}
            onChange={(e) => {
              const f = e.target.files?.[0];
              if (!f) return;
              const r = new FileReader();
              r.onload = (ev) => setNoteJson(ev.target?.result as string);
              r.readAsText(f);
            }}
          />
        </label>
      </Section>

      {/* Step 2: Swap secret */}
      <Section title="2. Swap secret (hashlock)">
        {!secretReady ? (
          <button onClick={generateSwapSecret} style={btnPrimary(true)}>
            Generate Swap Secret
          </button>
        ) : (
          <>
            <div style={secretBox}>
              <Row
                label="secret"
                value={swapSecret.slice(0, 20) + "…"}
                highlight={false}
              />
              <Row
                label="hashlock"
                value={swapHashlock.slice(0, 20) + "…"}
                highlight
              />
            </div>
            <button onClick={downloadSwapNote} style={btnGhost}>
              <FaDownload size={11} /> Save swap-secret.json (needed to claim
              STRK)
            </button>
            <p
              style={{
                color: "#f59e0b",
                fontSize: "0.64rem",
                margin: 0,
                lineHeight: 1.6,
              }}
            >
              ⚠ Share only the <b>hashlock</b> with Bob. Keep the secret private
              until you're ready to claim STRK.
            </p>
          </>
        )}
      </Section>

      {/* Step 3: STRK destination */}
      <Section title="3. Your STRK destination">
        <input
          value={strkDestination}
          onChange={(e) => setStrkDestination(e.target.value)}
          placeholder="0x… (fresh wallet for privacy)"
          style={inputStyle}
        />
        {address && !strkDestination && (
          <button
            onClick={() => setStrkDestination(address!)}
            style={{ ...btnGhost, marginTop: 0 }}
          >
            Use connected wallet
          </button>
        )}
      </Section>

      {/* Step 4: Slippage */}
      <Section title="4. Slippage tolerance">
        <div style={{ display: "flex", gap: "0.5rem", flexWrap: "wrap" }}>
          {SLIPPAGE_PRESETS.map(({ label, bps }) => (
            <button
              key={bps}
              onClick={() => {
                setSlippageBps(bps);
                setCustomSlippage("");
              }}
              style={chipStyle(effectiveSlippage === bps && !customSlippage)}
            >
              {label}
            </button>
          ))}
          <input
            value={customSlippage}
            onChange={(e) => setCustomSlippage(e.target.value)}
            placeholder="Custom bps"
            style={{
              ...inputStyle,
              width: 100,
              padding: "0.45rem 0.7rem",
              fontSize: "0.72rem",
            }}
          />
        </div>
        <p style={{ color: "#3a3a4a", fontSize: "0.62rem", margin: 0 }}>
          {effectiveSlippage} bps = {(effectiveSlippage / 100).toFixed(1)}% max
          price drop accepted
        </p>
      </Section>

      {/* Step 5: Expiry */}
      <Section title="5. Order expiry">
        <div style={{ display: "flex", gap: "0.5rem" }}>
          {EXPIRY_PRESETS.map(({ label, secs }) => (
            <button
              key={secs}
              onClick={() => setExpirySeconds(secs)}
              style={chipStyle(expirySeconds === secs)}
            >
              {label}
            </button>
          ))}
        </div>
        <p style={{ color: "#3a3a4a", fontSize: "0.62rem", margin: 0 }}>
          <RiTimeLine style={{ verticalAlign: "middle" }} /> Expires in{" "}
          {expirySeconds / 3600}h · Rate quote valid 1h
        </p>
      </Section>

      {step === 3 ? (
        <div
          style={{
            ...infoBox,
            background: "rgba(255,200,0,0.06)",
            borderColor: "rgba(255,200,0,0.25)",
            padding: "1.5rem",
          }}
        >
          <RiShieldKeyholeFill size={22} color="#ffc800" />
          <div>
            <div
              style={{ color: "#ffc800", fontWeight: 900, fontSize: "0.9rem" }}
            >
              Order posted!
            </div>
            <div
              style={{
                color: "#555",
                fontSize: "0.68rem",
                marginTop: "0.3rem",
                lineHeight: 1.7,
              }}
            >
              Share your hashlock with Bob. Once he fills it, reveal your secret
              via "Manage Orders" to claim STRK.
            </div>
            <div
              style={{
                color: "#3a3a4a",
                fontSize: "0.62rem",
                marginTop: "0.4rem",
                wordBreak: "break-all",
              }}
            >
              hashlock: {swapHashlock}
            </div>
          </div>
        </div>
      ) : (
        <button
          onClick={handlePost}
          disabled={!isValid || loading}
          style={btnPrimary(!!(isValid && !loading))}
        >
          {loading ? (
            <>
              <FaSpinner
                size={13}
                style={{ animation: "spin 1s linear infinite" }}
              />{" "}
              Generating proof & posting…
            </>
          ) : (
            <>
              <RiShieldKeyholeFill size={14} /> Post wBTC Order
            </>
          )}
        </button>
      )}
    </div>
  );
}

// ── Mini helpers ──────────────────────────────────────────────────────────────

function Section({
  title,
  children,
}: {
  title: string;
  children: React.ReactNode;
}) {
  return (
    <div
      style={{
        background: "#111118",
        border: "1px solid #1e1e2e",
        borderRadius: 10,
        padding: "1.1rem 1.2rem",
        display: "flex",
        flexDirection: "column",
        gap: "0.65rem",
      }}
    >
      <div
        style={{
          color: "#3a3a4a",
          fontSize: "0.6rem",
          letterSpacing: "0.15em",
          textTransform: "uppercase",
        }}
      >
        {title}
      </div>
      {children}
    </div>
  );
}

function Row({
  label,
  value,
  highlight,
}: {
  label: string;
  value: string;
  highlight: boolean;
}) {
  return (
    <div
      style={{
        display: "flex",
        justifyContent: "space-between",
        alignItems: "center",
      }}
    >
      <span style={{ color: "#1e1e2e", fontSize: "0.62rem" }}>{label}</span>
      <span
        style={{
          color: highlight ? "#ffc800" : "#555",
          fontSize: "0.62rem",
          fontFamily: "'DM Mono', monospace",
        }}
      >
        {value}
      </span>
    </div>
  );
}

const chipStyle = (active: boolean): React.CSSProperties => ({
  background: active ? "#ffc800" : "transparent",
  color: active ? "#0a0a0f" : "#555",
  border: `1px solid ${active ? "#ffc800" : "#2a2a3a"}`,
  borderRadius: 6,
  padding: "0.35rem 0.75rem",
  fontSize: "0.7rem",
  fontFamily: "'DM Mono', monospace",
  fontWeight: active ? 900 : 400,
  cursor: "pointer",
  transition: "all 0.15s",
});
const infoBox: React.CSSProperties = {
  display: "flex",
  alignItems: "flex-start",
  gap: "0.75rem",
  background: "rgba(255,200,0,0.04)",
  border: "1px solid rgba(255,200,0,0.1)",
  borderRadius: 10,
  padding: "1rem",
};
const rateBox: React.CSSProperties = {
  background: "#111118",
  border: "1px solid #1e1e2e",
  borderRadius: 10,
  padding: "1rem 1.25rem",
  display: "flex",
  justifyContent: "space-between",
  alignItems: "center",
};
const secretBox: React.CSSProperties = {
  background: "#0a0a0f",
  border: "1px solid #1e1e2e",
  borderRadius: 8,
  padding: "0.85rem",
  display: "flex",
  flexDirection: "column",
  gap: "0.35rem",
};
const labelStyle: React.CSSProperties = {
  color: "#3a3a4a",
  fontSize: "0.6rem",
  letterSpacing: "0.12em",
  textTransform: "uppercase",
  marginBottom: "0.25rem",
};
const uploadLabel: React.CSSProperties = {
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
};
