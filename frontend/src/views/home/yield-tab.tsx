import React, { useEffect, useState } from "react";
import { toast } from "react-toastify";
import { useAccount, useContract } from "@starknet-react/core";
import { uint256 } from "starknet";
import { FaSpinner, FaUpload } from "react-icons/fa";
import {
  RiPlantLine,
  RiCoinsLine,
  RiInformationLine,
  RiArrowDownLine,
} from "react-icons/ri";
import { poseidon2Hash } from "@zkpassport/poseidon2";
import abi from "../../assets/json/abi";
import { CONTRACT_ADDRESS } from "../../utils/constants";
import { merkleTree } from "../../helpers/merkle_tree";
import { useZkVerifier } from "../../helpers/gen_proof";
import { useIndexerDeposits } from "../../helpers/use_indexer_deposits";
import { type CommitmentData, inputStyle } from "./shared";
import { assertReceiptSuccess } from "../../utils/helpers";

type YieldState =
  | "idle"
  | "checking"
  | "not-earning"
  | "already-earning"
  | "start-done"
  | "stop-done";

export default function YieldTab() {
  const { address, account } = useAccount();
  const { contract } = useContract({ abi, address: CONTRACT_ADDRESS });
  const { generateProof } = useZkVerifier();
  const { fetchAllCommitments } = useIndexerDeposits();

  const [noteJson, setNoteJson] = useState("");
  const [yieldState, setYieldState] = useState<YieldState>("idle");
  const [yieldBalance, setYieldBalance] = useState<string | null>(null);
  const [nullifierHash, setNullifierHash] = useState<string | null>(null);
  const [startLoading, setStartLoading] = useState(false);
  const [stopLoading, setStopLoading] = useState(false);

  // ── Parse + check whenever a valid note is loaded ──────────────────────────
  const checkNote = async (raw: string) => {
    if (!contract || !raw.trim()) return;
    if (
      !raw.includes('"nullifier"') ||
      !raw.includes('"secret"') ||
      !raw.includes('"commitment"')
    )
      return;

    setYieldState("checking");
    setYieldBalance(null);
    setNullifierHash(null);

    try {
      const note: CommitmentData = JSON.parse(raw);
      const nhHex = "0x" + poseidon2Hash([BigInt(note.nullifier)]).toString(16);
      const nullHashU256 = uint256.bnToUint256(BigInt(nhHex));

      const [isEarning, balRaw] = await Promise.all([
        contract.call("is_earning", [nullHashU256]),
        contract.call("get_yield_balance", [nullHashU256]),
      ]);

      const earning = Boolean(isEarning);
      setNullifierHash(nhHex);
      setYieldBalance(
        earning ? (Number(balRaw) / 1e8).toFixed(8) + " wBTC" : null,
      );
      setYieldState(earning ? "already-earning" : "not-earning");
    } catch {
      setYieldState("idle");
    }
  };

  const handleNoteChange = (val: string) => {
    setNoteJson(val);
    setYieldState("idle");
    setYieldBalance(null);
    setNullifierHash(null);
    if (val.includes('"nullifier"') && val.includes('"commitment"')) {
      checkNote(val);
    }
  };

  // ── Poll balance every 15s while earning ──────────────────────────────────
  useEffect(() => {
    const isEarning =
      yieldState === "already-earning" || yieldState === "start-done";
    if (!isEarning || !contract || !nullifierHash) return;
    const poll = async () => {
      try {
        const bal = await contract.call("get_yield_balance", [
          uint256.bnToUint256(BigInt(nullifierHash)),
        ]);
        setYieldBalance((Number(bal) / 1e8).toFixed(8) + " wBTC");
      } catch {}
    };
    const id = setInterval(poll, 15000);
    return () => clearInterval(id);
  }, [yieldState, contract, nullifierHash]);

  // ── Start earning ──────────────────────────────────────────────────────────
  // Generates a ZK proof and calls start_earning(proof, recipient).
  // The contract marks the nullifier as SPENT and locks the recipient.
  // After this, only stop_earning(nullifier_hash) called by `recipient` can withdraw.
  const handleStartEarning = async () => {
    if (!account || !contract || !noteJson.trim() || !address) return;
    setStartLoading(true);
    const toastId = toast.loading("Building ZK proof…");
    try {
      const note: CommitmentData = JSON.parse(noteJson);
      const commitments = await fetchAllCommitments();
      const tree = await merkleTree(commitments);
      const leafIndex = tree.getIndex(BigInt(note.commitment).toString());
      if (leafIndex === -1)
        throw new Error(
          "Commitment not found — wait a moment for indexer sync.",
        );

      const merkleProof = tree.proof(leafIndex);
      const nhHex = "0x" + poseidon2Hash([BigInt(note.nullifier)]).toString(16);
      const recipientHash =
        "0x" + poseidon2Hash([BigInt(address)]).toString(16);

      const noirInput = {
        root: merkleProof.root.toString(),
        nullifier_hash: nullifierHash,
        recipient: address,
        recipient_hash: recipientHash,
        nullifier: note.nullifier,
        secret: note.secret,
        merkle_proof: merkleProof.pathElements.map((el: any) => el.toString()),
        is_even: merkleProof.pathIndices.map((el: any) => el % 2 === 0),
      };

      const { callData } = await generateProof(noirInput, (msg: string) => {
        toast.update(toastId, { render: msg });
      });

      toast.update(toastId, { render: "Submitting to Vesu…" });

      // start_earning(proof, recipient) — recipient is locked on-chain.
      // The nullifier is marked spent here; use stop_earning to withdraw later.
      const populate = contract.populate("start_earning", [
        callData.slice(1),
        address,
      ]);
      await account.estimateInvokeFee([populate]);
      const tx = await account.execute([populate]);
      const receipt = await account.waitForTransaction(tx.transaction_hash);
      assertReceiptSuccess(receipt);

      setNullifierHash(nhHex);
      setYieldState("start-done");
      await checkNote(noteJson);

      toast.update(toastId, {
        render: "Earning yield with Vesu! Use 'Withdraw Yield' to stop.",
        isLoading: false,
        type: "success",
        autoClose: 6000,
      });
    } catch (err: any) {
      const msg =
        err?.baseError?.data?.execution_error?.error ??
        err?.message ??
        String(err);
      toast.update(toastId, {
        render: msg,
        isLoading: false,
        type: "error",
        autoClose: 5000,
      });
    } finally {
      setStartLoading(false);
    }
  };

  // ── Stop earning ───────────────────────────────────────────────────────────
  // Calls stop_earning(nullifier_hash) — no ZK proof needed.
  // Only works if caller == the recipient committed during start_earning.
  // Contract redeems Vesu shares and sends wBTC + yield to the recipient.
  const handleStopEarning = async () => {
    if (!account || !contract || !nullifierHash) return;
    setStopLoading(true);
    const toastId = toast.loading("Redeeming Vesu position…");
    try {
      const nullHashU256 = uint256.bnToUint256(BigInt(nullifierHash));
      const populate = contract.populate("stop_earning", [nullHashU256]);
      await account.estimateInvokeFee([populate]);
      const tx = await account.execute([populate]);
      const receipt = await account.waitForTransaction(tx.transaction_hash);
      assertReceiptSuccess(receipt);

      setYieldState("stop-done");
      setYieldBalance(null);

      toast.update(toastId, {
        render: "Yield withdrawn! wBTC + earnings sent to your wallet.",
        isLoading: false,
        type: "success",
        autoClose: 5000,
      });
    } catch (err: any) {
      const msg =
        err?.baseError?.data?.execution_error?.error ??
        err?.message ??
        String(err);
      toast.update(toastId, {
        render: msg,
        isLoading: false,
        type: "error",
        autoClose: 5000,
      });
    } finally {
      setStopLoading(false);
    }
  };

  const isEarningState =
    yieldState === "already-earning" || yieldState === "start-done";
  const canStart = yieldState === "not-earning" && !!account && !startLoading;
  const canStop = isEarningState && !!account && !stopLoading;

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: "1rem" }}>
      {/* Header */}
      <div
        style={{
          display: "flex",
          alignItems: "flex-start",
          gap: "0.75rem",
          background: "rgba(34,197,94,0.04)",
          border: "1px solid rgba(34,197,94,0.15)",
          borderRadius: 10,
          padding: "1rem 1.1rem",
        }}
      >
        <RiPlantLine
          size={16}
          color="#22c55e"
          style={{ flexShrink: 0, marginTop: 2 }}
        />
        <div style={{ fontSize: "0.68rem", color: "#555", lineHeight: 1.8 }}>
          Lend your deposited wBTC on{" "}
          <span style={{ color: "#22c55e" }}>Vesu</span> and earn interest while
          you wait. When you're ready, withdraw your principal + yield directly
          from this tab.
        </div>
      </div>

      {/* How it works */}
      <div
        style={{
          background: "#111118",
          border: "1px solid #1e1e2e",
          borderRadius: 10,
          padding: "1.1rem 1.2rem",
          display: "flex",
          flexDirection: "column",
          gap: "0.7rem",
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
          How it works
        </div>
        <div
          style={{ display: "flex", flexDirection: "column", gap: "0.55rem" }}
        >
          <HowRow n="1" text="Load your umbra-note.json below" />
          <HowRow
            n="2"
            text="A ZK proof proves you own the deposit and locks your recipient address"
          />
          <HowRow
            n="3"
            text="Your wBTC moves into Vesu's lending pool and earns interest"
          />
          <HowRow
            n="4"
            text='When ready, click "Withdraw Yield" — your wallet receives principal + all accrued yield'
          />
        </div>

        {/* Important note about nullifier */}
        <div
          style={{
            background: "rgba(245,158,11,0.05)",
            border: "1px solid rgba(245,158,11,0.2)",
            borderRadius: 8,
            padding: "0.75rem 0.9rem",
            display: "flex",
            alignItems: "flex-start",
            gap: "0.6rem",
            marginTop: "0.25rem",
          }}
        >
          <RiInformationLine
            size={13}
            color="#f59e0b"
            style={{ flexShrink: 0, marginTop: 1 }}
          />
          <p
            style={{
              color: "#a07820",
              fontSize: "0.63rem",
              lineHeight: 1.75,
              margin: 0,
            }}
          >
            <strong style={{ color: "#f59e0b" }}>Note:</strong> Starting yield
            earmarking spends your note's nullifier. You won't be able to use
            this note in the Withdraw or Swap tabs afterward — use{" "}
            <strong style={{ color: "#f59e0b" }}>Withdraw Yield</strong> here
            instead.
          </p>
        </div>
      </div>

      {/* Note loader — hidden once earning */}
      {!isEarningState && yieldState !== "stop-done" && (
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
            Your deposit note
          </div>
          <textarea
            value={noteJson}
            onChange={(e) => handleNoteChange(e.target.value)}
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
            htmlFor="yield-note-file"
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
            onMouseEnter={(e) => (e.currentTarget.style.borderColor = "#555")}
            onMouseLeave={(e) =>
              (e.currentTarget.style.borderColor = "#1e1e2e")
            }
          >
            <FaUpload size={10} /> Upload umbra-note.json
            <input
              id="yield-note-file"
              type="file"
              accept=".json"
              style={{ display: "none" }}
              onChange={(e) => {
                const f = e.target.files?.[0];
                if (!f) return;
                const r = new FileReader();
                r.onload = (ev) => {
                  const val = ev.target?.result as string;
                  setNoteJson(val);
                  checkNote(val);
                };
                r.readAsText(f);
              }}
            />
          </label>
        </div>
      )}

      {/* Status: checking */}
      {yieldState === "checking" && (
        <StatusBox color="#3a3a4a" border="#1e1e2e" bg="#111118">
          <FaSpinner
            size={13}
            style={{ animation: "spin 1s linear infinite", flexShrink: 0 }}
          />
          <span>Checking position on-chain…</span>
        </StatusBox>
      )}

      {/* Status: not earning */}
      {yieldState === "not-earning" && (
        <div
          style={{
            background: "#111118",
            border: "1px solid #1e1e2e",
            borderRadius: 10,
            padding: "1.1rem 1.2rem",
            display: "flex",
            flexDirection: "column",
            gap: "0.75rem",
          }}
        >
          <div style={{ display: "flex", alignItems: "center", gap: "0.6rem" }}>
            <RiInformationLine size={14} color="#555" />
            <span style={{ color: "#555", fontSize: "0.68rem" }}>
              This deposit is not yet earning yield.
            </span>
          </div>
          <div
            style={{
              background: "#0a0a0f",
              border: "1px solid #1e1e2e",
              borderRadius: 8,
              padding: "0.85rem",
              display: "flex",
              alignItems: "flex-start",
              gap: "0.6rem",
            }}
          >
            <RiCoinsLine
              size={13}
              color="#22c55e"
              style={{ flexShrink: 0, marginTop: 2 }}
            />
            <p
              style={{
                color: "#3a3a4a",
                fontSize: "0.65rem",
                lineHeight: 1.75,
                margin: 0,
              }}
            >
              Longer deposits in the pool = stronger anonymity set. Earning
              yield while you wait is a{" "}
              <span style={{ color: "#22c55e" }}>
                privacy win and a financial win.
              </span>
            </p>
          </div>
        </div>
      )}

      {/* Status: earning — live balance + stop button */}
      {isEarningState && (
        <div
          style={{
            background: "rgba(34,197,94,0.04)",
            border: "1px solid rgba(34,197,94,0.25)",
            borderRadius: 10,
            padding: "1.25rem",
            display: "flex",
            flexDirection: "column",
            gap: "0.85rem",
          }}
        >
          {/* Earning header */}
          <div
            style={{ display: "flex", alignItems: "center", gap: "0.65rem" }}
          >
            <div
              style={{
                width: 32,
                height: 32,
                borderRadius: "50%",
                background: "rgba(34,197,94,0.1)",
                border: "1px solid rgba(34,197,94,0.3)",
                display: "flex",
                alignItems: "center",
                justifyContent: "center",
                flexShrink: 0,
              }}
            >
              <RiPlantLine size={15} color="#22c55e" />
            </div>
            <div>
              <div
                style={{
                  color: "#22c55e",
                  fontSize: "0.78rem",
                  fontWeight: 700,
                }}
              >
                Earning yield with Vesu
              </div>
              <div
                style={{
                  color: "#3a3a4a",
                  fontSize: "0.6rem",
                  marginTop: "0.1rem",
                }}
              >
                Interest accrues automatically · withdraw anytime below
              </div>
            </div>
          </div>

          {/* Live balance */}
          <div
            style={{
              background: "#0a0a0f",
              border: "1px solid #1e1e2e",
              borderRadius: 8,
              padding: "1rem 1.25rem",
              display: "flex",
              justifyContent: "space-between",
              alignItems: "center",
            }}
          >
            <div>
              <div
                style={{
                  color: "#3a3a4a",
                  fontSize: "0.58rem",
                  letterSpacing: "0.14em",
                  textTransform: "uppercase",
                  marginBottom: "0.3rem",
                }}
              >
                Current position value
              </div>
              <div
                style={{
                  color: "#22c55e",
                  fontSize: "1.1rem",
                  fontWeight: 700,
                  fontFamily: "'DM Mono', monospace",
                }}
              >
                {yieldBalance ?? (
                  <FaSpinner
                    size={12}
                    style={{ animation: "spin 1s linear infinite" }}
                  />
                )}
              </div>
            </div>
            <div style={{ textAlign: "right" }}>
              <div
                style={{
                  color: "#3a3a4a",
                  fontSize: "0.58rem",
                  letterSpacing: "0.14em",
                  textTransform: "uppercase",
                  marginBottom: "0.3rem",
                }}
              >
                Updates every
              </div>
              <div style={{ color: "#555", fontSize: "0.7rem" }}>15s</div>
            </div>
          </div>

          {/* Recipient note */}
          <div
            style={{
              background: "rgba(34,197,94,0.03)",
              border: "1px solid rgba(34,197,94,0.1)",
              borderRadius: 8,
              padding: "0.7rem 0.9rem",
              display: "flex",
              alignItems: "flex-start",
              gap: "0.5rem",
            }}
          >
            <RiInformationLine
              size={12}
              color="#22c55e"
              style={{ flexShrink: 0, marginTop: 1 }}
            />
            <p
              style={{
                color: "#3a3a4a",
                fontSize: "0.62rem",
                margin: 0,
                lineHeight: 1.7,
              }}
            >
              Yield will be sent to the wallet that started earning. Click{" "}
              <strong style={{ color: "#22c55e" }}>Withdraw Yield</strong> below
              to redeem your Vesu shares and receive wBTC + all accrued
              interest.
            </p>
          </div>

          {/* Stop earning button */}
          <button
            onClick={handleStopEarning}
            disabled={!canStop}
            style={{
              width: "100%",
              background: canStop
                ? "rgba(34,197,94,0.12)"
                : "rgba(34,197,94,0.03)",
              color: canStop ? "#22c55e" : "#2a4a2a",
              border: `1px solid ${canStop ? "rgba(34,197,94,0.35)" : "rgba(34,197,94,0.1)"}`,
              borderRadius: 8,
              padding: "0.9rem",
              fontSize: "0.82rem",
              fontFamily: "'DM Mono', monospace",
              fontWeight: 900,
              letterSpacing: "0.08em",
              cursor: canStop ? "pointer" : "not-allowed",
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              gap: "0.5rem",
              transition: "all 0.2s",
            }}
          >
            {stopLoading ? (
              <>
                <FaSpinner
                  size={13}
                  style={{ animation: "spin 1s linear infinite" }}
                />
                Redeeming shares…
              </>
            ) : (
              <>
                <RiArrowDownLine size={14} />
                Withdraw Yield
              </>
            )}
          </button>
        </div>
      )}

      {/* Status: withdrawn */}
      {yieldState === "stop-done" && (
        <div
          style={{
            background: "rgba(34,197,94,0.06)",
            border: "1px solid rgba(34,197,94,0.3)",
            borderRadius: 10,
            padding: "1.25rem",
            display: "flex",
            flexDirection: "column",
            gap: "0.5rem",
            alignItems: "center",
            textAlign: "center",
          }}
        >
          <RiPlantLine size={24} color="#22c55e" />
          <div
            style={{ color: "#22c55e", fontSize: "0.82rem", fontWeight: 700 }}
          >
            Yield withdrawn successfully
          </div>
          <div
            style={{ color: "#3a3a4a", fontSize: "0.65rem", lineHeight: 1.7 }}
          >
            Your wBTC + accrued interest has been sent to your wallet.
          </div>
        </div>
      )}

      {/* Start earning CTA — only shown when not already earning */}
      {!isEarningState && yieldState !== "stop-done" && (
        <button
          onClick={handleStartEarning}
          disabled={!canStart}
          style={{
            width: "100%",
            background: canStart ? "rgba(34,197,94,0.12)" : "#111118",
            color: canStart ? "#22c55e" : "#2a2a3a",
            border: `1px solid ${canStart ? "rgba(34,197,94,0.35)" : "#1e1e2e"}`,
            borderRadius: 8,
            padding: "1rem",
            fontSize: "0.85rem",
            fontFamily: "'DM Mono', monospace",
            fontWeight: 900,
            letterSpacing: "0.08em",
            cursor: canStart ? "pointer" : "not-allowed",
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            gap: "0.5rem",
            transition: "all 0.2s",
          }}
        >
          {startLoading ? (
            <>
              <FaSpinner
                size={13}
                style={{ animation: "spin 1s linear infinite" }}
              />
              Generating ZK proof…
            </>
          ) : (
            <>
              <RiPlantLine size={14} />
              Start Earning with Vesu
            </>
          )}
        </button>
      )}

      {!account && (
        <p
          style={{
            color: "#f59e0b",
            fontSize: "0.65rem",
            textAlign: "center",
            margin: 0,
          }}
        >
          Connect your wallet to start earning
        </p>
      )}
    </div>
  );
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function HowRow({ n, text }: { n: string; text: string }) {
  return (
    <div style={{ display: "flex", alignItems: "flex-start", gap: "0.65rem" }}>
      <div
        style={{
          width: 20,
          height: 20,
          borderRadius: "50%",
          background: "#0a0a0f",
          border: "1px solid #1e1e2e",
          color: "#3a3a4a",
          fontSize: "0.58rem",
          fontWeight: 700,
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          flexShrink: 0,
          marginTop: 1,
        }}
      >
        {n}
      </div>
      <span style={{ color: "#555", fontSize: "0.67rem", lineHeight: 1.7 }}>
        {text}
      </span>
    </div>
  );
}

function StatusBox({
  color,
  border,
  bg,
  children,
}: {
  color: string;
  border: string;
  bg: string;
  children: React.ReactNode;
}) {
  return (
    <div
      style={{
        display: "flex",
        alignItems: "center",
        gap: "0.65rem",
        background: bg,
        border: `1px solid ${border}`,
        borderRadius: 8,
        padding: "0.85rem 1rem",
        color,
        fontSize: "0.68rem",
      }}
    >
      {children}
    </div>
  );
}
