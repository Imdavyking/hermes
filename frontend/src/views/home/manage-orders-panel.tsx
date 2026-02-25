import React, { useState } from "react";
import { toast } from "react-toastify";
import { useAccount, useContract } from "@starknet-react/core";
import { uint256 } from "starknet";
import { FaSpinner, FaUpload } from "react-icons/fa";
import {
  RiArrowRightLine,
  RiRefund2Line,
  RiMoneyDollarCircleLine,
} from "react-icons/ri";
import abi from "../../assets/json/abi";
import { CONTRACT_ADDRESS, U128_MAX, U64_MAX } from "../../utils/constants";
import { btnPrimary, inputStyle } from "./shared";

type ActionMode =
  | "withdraw_strk"
  | "withdraw_wbtc"
  | "refund_wbtc"
  | "refund_strk";

interface OrderStatus {
  isWithdrawn: boolean;
  isRefunded: boolean;
  isFilled: boolean;
  isExpired: boolean;
  swapInitiated: boolean;
  secretRevealed: boolean;
  strkAmount?: string;
  wbtcAmount?: string;
  hashlock?: string;
  expiry?: number;
}

export default function ManageOrdersPanel() {
  const { account } = useAccount();
  const { contract } = useContract({ abi, address: CONTRACT_ADDRESS });

  const [mode, setMode] = useState<ActionMode>("withdraw_strk");
  const [orderId, setOrderId] = useState("");
  const [secret, setSecret] = useState("");
  const [secretJson, setSecretJson] = useState("");
  const [orderStatus, setOrderStatus] = useState<OrderStatus | null>(null);
  const [lookupLoading, setLookupLoading] = useState(false);
  const [actionLoading, setActionLoading] = useState(false);

  const lookupOrder = async () => {
    if (!contract || !orderId.trim()) return;
    setLookupLoading(true);
    setOrderStatus(null);
    try {
      const idU256 = uint256.bnToUint256(BigInt(orderId.trim()));
      const now = Math.floor(Date.now() / 1000);

      if (mode === "withdraw_strk" || mode === "refund_strk") {
        const o = (await contract.call("get_strk_order", [idU256])) as any;
        setOrderStatus({
          isWithdrawn: Boolean(o.is_withdrawn),
          isRefunded: Boolean(o.is_refunded),
          isFilled: false,
          isExpired: now >= Number(o.expiry),
          swapInitiated: false,
          secretRevealed: false,
          strkAmount: o.strk_amount?.toString(),
          expiry: Number(o.expiry),
          hashlock: "0x" + BigInt(o.hashlock).toString(16),
        });
      } else {
        const o = (await contract.call("get_wbtc_order", [idU256])) as any;
        setOrderStatus({
          isWithdrawn: Boolean(o.is_withdrawn),
          isRefunded: Boolean(o.is_refunded),
          isFilled: Boolean(o.is_filled),
          isExpired: now >= Number(o.expiry),
          swapInitiated: Boolean(o.swap_initiated),
          secretRevealed: BigInt(o.secret ?? 0) !== 0n,
          wbtcAmount: o.wbtc_amount?.toString(),
          expiry: Number(o.expiry),
          hashlock: "0x" + BigInt(o.hashlock).toString(16),
        });
      }
    } catch (err: any) {
      toast.error("Lookup failed: " + err?.message);
    } finally {
      setLookupLoading(false);
    }
  };

  const loadSecretFromFile = (file: File) => {
    const r = new FileReader();
    r.onload = (ev) => {
      try {
        const data = JSON.parse(ev.target?.result as string);
        if (data.swapSecret) setSecret(data.swapSecret);
        setSecretJson(ev.target?.result as string);
      } catch {
        toast.error("Invalid secret file.");
      }
    };
    r.readAsText(file);
  };

  const handleWithdrawStrk = async () => {
    if (!account || !contract || !orderId || !secret) return;
    setActionLoading(true);
    try {
      const idU256 = uint256.bnToUint256(BigInt(orderId.trim()));
      const tx = await account.execute(
        [contract.populate("withdraw_strk", [idU256, secret])],
        { maxFee: U128_MAX, version: "0x3" } as any,
      );
      await account.waitForTransaction(tx.transaction_hash);
      toast.success(
        "STRK claimed! Your secret is now public — Bob can claim wBTC.",
      );
      setOrderStatus((prev) => (prev ? { ...prev, isWithdrawn: true } : null));
    } catch (err: any) {
      toast.error(err?.message ?? String(err));
    } finally {
      setActionLoading(false);
    }
  };

  const handleWithdrawWbtc = async () => {
    if (!account || !contract || !orderId) return;
    setActionLoading(true);
    try {
      const idU256 = uint256.bnToUint256(BigInt(orderId.trim()));
      const tx = await account.execute(
        [contract.populate("withdraw_wbtc", [idU256])],
        { maxFee: U128_MAX, version: "0x3" } as any,
      );
      await account.waitForTransaction(tx.transaction_hash);
      toast.success("wBTC claimed! Swap complete.");
      setOrderStatus((prev) => (prev ? { ...prev, isWithdrawn: true } : null));
    } catch (err: any) {
      toast.error(err?.message ?? String(err));
    } finally {
      setActionLoading(false);
    }
  };

  const handleRefundWbtc = async () => {
    if (!account || !contract || !orderId) return;
    setActionLoading(true);
    try {
      const idU256 = uint256.bnToUint256(BigInt(orderId.trim()));
      const tx = await account.execute(
        [contract.populate("refund_wbtc", [idU256])],
        { maxFee: U128_MAX, version: "0x3" } as any,
      );
      await account.waitForTransaction(tx.transaction_hash);
      toast.success("wBTC refunded back to you.");
      setOrderStatus((prev) => (prev ? { ...prev, isRefunded: true } : null));
    } catch (err: any) {
      toast.error(err?.message ?? String(err));
    } finally {
      setActionLoading(false);
    }
  };

  const handleRefundStrk = async () => {
    if (!account || !contract || !orderId) return;
    setActionLoading(true);
    try {
      const idU256 = uint256.bnToUint256(BigInt(orderId.trim()));
      const tx = await account.execute(
        [contract.populate("refund_strk", [idU256])],
        { maxFee: U128_MAX, version: "0x3" } as any,
      );
      await account.waitForTransaction(tx.transaction_hash);
      toast.success("STRK refunded back to you.");
      setOrderStatus((prev) => (prev ? { ...prev, isRefunded: true } : null));
    } catch (err: any) {
      toast.error(err?.message ?? String(err));
    } finally {
      setActionLoading(false);
    }
  };

  const MODES: {
    key: ActionMode;
    label: string;
    sublabel: string;
    icon: React.ReactNode;
  }[] = [
    {
      key: "withdraw_strk",
      label: "Claim STRK",
      sublabel: "Alice reveals secret",
      icon: <RiMoneyDollarCircleLine size={13} />,
    },
    {
      key: "withdraw_wbtc",
      label: "Claim wBTC",
      sublabel: "Bob uses revealed secret",
      icon: <RiArrowRightLine size={13} />,
    },
    {
      key: "refund_wbtc",
      label: "Refund wBTC",
      sublabel: "Alice, if order expired",
      icon: <RiRefund2Line size={13} />,
    },
    {
      key: "refund_strk",
      label: "Refund STRK",
      sublabel: "Bob, if Alice vanished",
      icon: <RiRefund2Line size={13} />,
    },
  ];

  const canAct = () => {
    if (!orderStatus) return false;
    if (orderStatus.isWithdrawn || orderStatus.isRefunded) return false;
    if (mode === "withdraw_strk") return !orderStatus.isExpired && !!secret;
    if (mode === "withdraw_wbtc") return orderStatus.secretRevealed;
    if (mode === "refund_wbtc")
      return (
        orderStatus.isExpired &&
        !orderStatus.swapInitiated &&
        !orderStatus.isFilled
      );
    if (mode === "refund_strk") return orderStatus.isExpired;
    return false;
  };

  const getStatusMessage = () => {
    if (!orderStatus) return null;
    if (orderStatus.isWithdrawn)
      return { text: "Already claimed.", color: "#22c55e" };
    if (orderStatus.isRefunded)
      return { text: "Already refunded.", color: "#22c55e" };
    if (mode === "withdraw_strk" && orderStatus.isExpired)
      return {
        text: "STRK order expired — use Refund STRK instead.",
        color: "#f87171",
      };
    if (mode === "withdraw_wbtc" && !orderStatus.secretRevealed)
      return {
        text: "Secret not yet revealed. Wait for Alice to call withdraw_strk first.",
        color: "#f59e0b",
      };
    if (mode === "withdraw_wbtc" && orderStatus.secretRevealed)
      return {
        text: "Secret is on-chain! You can claim your wBTC.",
        color: "#22c55e",
      };
    if (mode === "refund_wbtc" && orderStatus.isFilled)
      return {
        text: "Order is filled — cannot refund while Bob's STRK is locked.",
        color: "#f87171",
      };
    if (mode === "refund_wbtc" && !orderStatus.isExpired)
      return { text: "Order hasn't expired yet.", color: "#f59e0b" };
    if (mode === "refund_strk" && !orderStatus.isExpired)
      return { text: "Order hasn't expired yet.", color: "#f59e0b" };
    return null;
  };

  const statusMsg = getStatusMessage();
  const executeAction = () => {
    if (mode === "withdraw_strk") handleWithdrawStrk();
    else if (mode === "withdraw_wbtc") handleWithdrawWbtc();
    else if (mode === "refund_wbtc") handleRefundWbtc();
    else handleRefundStrk();
  };

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: "1rem" }}>
      {/* Mode selector */}
      <div
        style={{
          display: "grid",
          gridTemplateColumns: "1fr 1fr",
          gap: "0.5rem",
        }}
      >
        {MODES.map(({ key, label, sublabel, icon }) => (
          <button
            key={key}
            onClick={() => {
              setMode(key);
              setOrderStatus(null);
            }}
            style={{
              background: mode === key ? "rgba(255,200,0,0.08)" : "#111118",
              border: `1px solid ${mode === key ? "rgba(255,200,0,0.35)" : "#1e1e2e"}`,
              borderRadius: 8,
              padding: "0.8rem",
              cursor: "pointer",
              transition: "all 0.15s",
              textAlign: "left",
            }}
          >
            <div
              style={{
                display: "flex",
                alignItems: "center",
                gap: "0.4rem",
                color: mode === key ? "#ffc800" : "#555",
                fontSize: "0.72rem",
                fontWeight: 700,
                marginBottom: "0.2rem",
              }}
            >
              {icon} {label}
            </div>
            <div
              style={{
                color: "#2a2a3a",
                fontSize: "0.58rem",
                letterSpacing: "0.08em",
              }}
            >
              {sublabel}
            </div>
          </button>
        ))}
      </div>

      {/* How-it-works hint per mode */}
      <HintBox mode={mode} />

      {/* Order ID lookup */}
      <div style={section}>
        <div style={sectionLabel}>
          {mode.includes("strk") ? "STRK order ID" : "wBTC order ID"}
        </div>
        <div style={{ display: "flex", gap: "0.5rem" }}>
          <input
            value={orderId}
            onChange={(e) => setOrderId(e.target.value)}
            placeholder="0x…"
            style={{ ...inputStyle, flex: 1 }}
          />
          <button
            onClick={lookupOrder}
            disabled={lookupLoading || !orderId.trim()}
            style={{
              ...btnPrimary(!!(orderId.trim() && !lookupLoading)),
              width: "auto",
              padding: "0.6rem 1rem",
              flexShrink: 0,
            }}
          >
            {lookupLoading ? (
              <FaSpinner
                size={11}
                style={{ animation: "spin 1s linear infinite" }}
              />
            ) : (
              "Check"
            )}
          </button>
        </div>

        {orderStatus && (
          <div
            style={{
              display: "flex",
              flexDirection: "column",
              gap: "0.4rem",
              background: "#0a0a0f",
              borderRadius: 8,
              padding: "0.85rem",
            }}
          >
            <StatusRow
              label="Withdrawn"
              value={orderStatus.isWithdrawn ? "Yes" : "No"}
              bad={orderStatus.isWithdrawn}
            />
            <StatusRow
              label="Refunded"
              value={orderStatus.isRefunded ? "Yes" : "No"}
              bad={orderStatus.isRefunded}
            />
            {orderStatus.expiry && (
              <StatusRow
                label="Expiry"
                value={new Date(orderStatus.expiry * 1000).toLocaleString()}
                bad={orderStatus.isExpired}
              />
            )}
            {mode === "withdraw_wbtc" && (
              <StatusRow
                label="Secret revealed"
                value={orderStatus.secretRevealed ? "Yes ✓" : "Not yet"}
                good={orderStatus.secretRevealed}
              />
            )}
            {orderStatus.strkAmount && (
              <StatusRow
                label="STRK amount"
                value={
                  (Number(orderStatus.strkAmount) / 1e18).toLocaleString(
                    undefined,
                    { maximumFractionDigits: 8 },
                  ) + " STRK"
                }
              />
            )}
            {orderStatus.wbtcAmount && (
              <StatusRow
                label="wBTC amount"
                value={orderStatus.wbtcAmount + " sat"}
              />
            )}
          </div>
        )}

        {statusMsg && (
          <div
            style={{
              color: statusMsg.color,
              fontSize: "0.68rem",
              padding: "0.6rem",
              background: statusMsg.color + "10",
              borderRadius: 6,
              lineHeight: 1.6,
            }}
          >
            {statusMsg.text}
          </div>
        )}
      </div>

      {/* Secret input — only for withdraw_strk */}
      {mode === "withdraw_strk" && (
        <div style={section}>
          <div style={sectionLabel}>Your swap secret</div>
          <input
            value={secret}
            onChange={(e) => setSecret(e.target.value)}
            placeholder="0x… (your secret from umbra-swap-secret.json)"
            style={inputStyle}
          />
          <label
            htmlFor="secret-file"
            style={uploadLabel}
            onMouseEnter={(e) => (e.currentTarget.style.borderColor = "#555")}
            onMouseLeave={(e) =>
              (e.currentTarget.style.borderColor = "#1e1e2e")
            }
          >
            <FaUpload size={10} /> Upload umbra-swap-secret.json
            <input
              id="secret-file"
              type="file"
              accept=".json"
              style={{ display: "none" }}
              onChange={(e) => {
                const f = e.target.files?.[0];
                if (f) loadSecretFromFile(f);
              }}
            />
          </label>
          {secret && (
            <p
              style={{
                color: "#3a3a4a",
                fontSize: "0.62rem",
                margin: 0,
                wordBreak: "break-all",
              }}
            >
              Secret: {secret.slice(0, 22)}…
            </p>
          )}
        </div>
      )}

      {/* Action button */}
      <button
        onClick={executeAction}
        disabled={!canAct() || actionLoading || !account}
        style={btnPrimary(!!(canAct() && !actionLoading && account))}
      >
        {actionLoading ? (
          <>
            <FaSpinner
              size={13}
              style={{ animation: "spin 1s linear infinite" }}
            />{" "}
            Processing…
          </>
        ) : (
          <>
            {MODES.find((m) => m.key === mode)?.icon}
            {MODES.find((m) => m.key === mode)?.label}
          </>
        )}
      </button>

      {!account && (
        <p
          style={{
            color: "#f59e0b",
            fontSize: "0.65rem",
            textAlign: "center",
            margin: 0,
          }}
        >
          Connect your wallet to act on orders
        </p>
      )}
    </div>
  );
}

// ── Hint box per mode ─────────────────────────────────────────────────────────

function HintBox({ mode }: { mode: ActionMode }) {
  const hints: Record<ActionMode, { title: string; body: string }> = {
    withdraw_strk: {
      title: "Alice claims STRK",
      body: "You (Alice) reveal your secret to receive STRK from Bob's locked order. This makes the secret public so Bob can then claim his wBTC. Use your STRK order ID (from the WbtcOrderFilled event).",
    },
    withdraw_wbtc: {
      title: "Bob claims wBTC",
      body: "Once Alice reveals her secret (via Claim STRK), the secret is stored on-chain. Bob calls this to claim his wBTC. No secret needed — the contract reads it from the wBTC order.",
    },
    refund_wbtc: {
      title: "Alice refunds her wBTC",
      body: "If the order expired and was never filled, Alice can reclaim her wBTC. Cannot be used if Bob already locked his STRK (use Refund STRK first).",
    },
    refund_strk: {
      title: "Bob refunds his STRK",
      body: "If Alice never revealed the secret before Bob's expiry, Bob can reclaim his STRK. Bob's expiry is always shorter than Alice's by design.",
    },
  };
  const h = hints[mode];
  return (
    <div
      style={{
        background: "rgba(255,200,0,0.02)",
        border: "1px solid #1e1e2e",
        borderRadius: 8,
        padding: "0.85rem 1rem",
      }}
    >
      <div
        style={{
          color: "#555",
          fontSize: "0.65rem",
          fontWeight: 700,
          marginBottom: "0.25rem",
        }}
      >
        {h.title}
      </div>
      <div style={{ color: "#3a3a4a", fontSize: "0.62rem", lineHeight: 1.8 }}>
        {h.body}
      </div>
    </div>
  );
}

function StatusRow({
  label,
  value,
  good,
  bad,
}: {
  label: string;
  value: string;
  good?: boolean;
  bad?: boolean;
}) {
  return (
    <div style={{ display: "flex", justifyContent: "space-between" }}>
      <span style={{ color: "#3a3a4a", fontSize: "0.62rem" }}>{label}</span>
      <span
        style={{
          color: good ? "#22c55e" : bad ? "#f87171" : "#aaa",
          fontSize: "0.62rem",
        }}
      >
        {value}
      </span>
    </div>
  );
}

const section: React.CSSProperties = {
  background: "#111118",
  border: "1px solid #1e1e2e",
  borderRadius: 10,
  padding: "1.1rem 1.2rem",
  display: "flex",
  flexDirection: "column",
  gap: "0.65rem",
};
const sectionLabel: React.CSSProperties = {
  color: "#3a3a4a",
  fontSize: "0.6rem",
  letterSpacing: "0.15em",
  textTransform: "uppercase",
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
