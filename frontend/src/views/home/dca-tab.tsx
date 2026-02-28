import React, { useState, useCallback } from "react";
import { toast } from "react-toastify";
import { useAccount, useContract, useReadContract } from "@starknet-react/core";
import { CallData, uint256, type Call } from "starknet";
import { FaSpinner, FaBitcoin, FaSync, FaChevronDown } from "react-icons/fa";
import {
  RiTimeLine,
  RiLoopLeftLine,
  RiCloseLine,
  RiAddLine,
} from "react-icons/ri";
import { useQuery } from "@apollo/client";
import abi from "../../assets/json/abi";
import { CONTRACT_ADDRESS } from "../../utils/constants";
import { btnPrimary, btnGhost, inputStyle } from "./shared";
import { assertReceiptSuccess } from "../../utils/helpers";
import { GET_ACTIVE_DCA_ORDERS, GET_DCA_EXECUTIONS } from "@/graphql/queries";

// ── Queries ──────────────────────────────────────────────────────────────────

// ── Types ─────────────────────────────────────────────────────────────────────

interface DcaOrder {
  orderId: string;
  usdcRecipient: string;
  usdcPerInterval: string;
  intervalSeconds: number;
  executionsTotal: number;
  executionsLeft: number;
  nextExecution: number;
  createdTxHash: string;
  lastExecutedAtBlock?: number;
}

interface DcaExecution {
  executionNumber: number;
  usdcSpent: string;
  wbtcReceived: string;
  btcPriceUsd: string;
  executedTimestamp: number;
  executedTxHash: string;
}

// ── Formatters ────────────────────────────────────────────────────────────────

function fmtUsdc(raw: string) {
  return (
    "$" +
    (Number(raw) / 1e6).toLocaleString(undefined, {
      minimumFractionDigits: 2,
      maximumFractionDigits: 2,
    })
  );
}
function fmtSats(raw: string) {
  return (Number(raw) / 1e8).toFixed(8) + " wBTC";
}
function fmtPrice(raw: string) {
  return (
    "$" +
    (Number(raw) / 1e8).toLocaleString(undefined, { maximumFractionDigits: 0 })
  );
}
function fmtInterval(secs: number) {
  if (secs < 3600) return `${secs / 60}m`;
  if (secs < 86400) return `${secs / 3600}h`;
  return `${Math.round(secs / 86400)}d`;
}
function fmtCountdown(ts: number, now: number) {
  const diff = ts - now;
  if (diff <= 0) return "Ready";
  if (diff < 3600) return `${Math.floor(diff / 60)}m`;
  if (diff < 86400)
    return `${Math.floor(diff / 3600)}h ${Math.floor((diff % 3600) / 60)}m`;
  return `${Math.floor(diff / 86400)}d`;
}
function fmtDate(ts: number) {
  return new Date(ts * 1000).toLocaleDateString(undefined, {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}
function toHexAddr(raw: string) {
  return "0x" + BigInt(raw).toString(16).padStart(64, "0");
}

// ── Interval presets ──────────────────────────────────────────────────────────

const INTERVAL_PRESETS = [
  { label: "1h", secs: 3600 },
  { label: "6h", secs: 21600 },
  { label: "1d", secs: 86400 },
  { label: "1w", secs: 604800 },
];

const EXECUTIONS_PRESETS = [3, 6, 12, 24, 52];

// ── Main component ────────────────────────────────────────────────────────────

export default function DcaTab() {
  const { address, account } = useAccount();
  const { contract } = useContract({ abi, address: CONTRACT_ADDRESS });

  // ── Create form state ──────────────────────────────────────────────────────
  const [usdcAmount, setUsdcAmount] = useState("");
  const [intervalSecs, setIntervalSecs] = useState(86400);
  const [customInterval, setCustomInterval] = useState("");
  const [executions, setExecutions] = useState(12);
  const [customExec, setCustomExec] = useState("");
  const [recipient, setRecipient] = useState("");
  const [creating, setCreating] = useState(false);
  const [approving, setApproving] = useState(false);

  // ── Orders list ────────────────────────────────────────────────────────────
  const [expandedOrderId, setExpandedOrderId] = useState<string | null>(null);
  const [cancelling, setCancelling] = useState<string | null>(null);
  const [hiddenOrders, setHiddenOrders] = useState<Set<string>>(new Set());

  const myAddr = address ? toHexAddr(address) : "";

  const {
    data: ordersData,
    loading: ordersLoading,
    refetch: refetchOrders,
  } = useQuery(GET_ACTIVE_DCA_ORDERS, {
    variables: { owner: myAddr },
    skip: !myAddr,
    fetchPolicy: "network-only",
  });

  const orders: DcaOrder[] = ((ordersData?.dcaorders ?? []) as any[])
    .filter((o: any) => !hiddenOrders.has(o.order_id ?? o.id))
    .map((o: any) => ({
      orderId: o.order_id ?? o.id,
      usdcRecipient: o.usdc_recipient,
      usdcPerInterval: o.usdc_per_interval,
      intervalSeconds: Number(o.interval_seconds),
      executionsTotal: Number(o.executions_total),
      executionsLeft: Number(o.executions_left),
      nextExecution: Number(o.next_execution),
      createdTxHash: o.created_tx_hash,
      lastExecutedAtBlock: o.last_executed_at_block
        ? Number(o.last_executed_at_block)
        : undefined,
    }));

  // ── Execution history for expanded order ──────────────────────────────────
  const { data: execData, loading: execLoading } = useQuery(
    GET_DCA_EXECUTIONS,
    {
      variables: { orderId: expandedOrderId ?? "" },
      skip: !expandedOrderId,
      fetchPolicy: "network-only",
    },
  );

  const executions_history: DcaExecution[] = (
    (execData?.dcaexecutions ?? []) as any[]
  ).map((e: any) => ({
    executionNumber: Number(e.execution_number),
    usdcSpent: e.usdc_spent,
    wbtcReceived: e.wbtc_received,
    btcPriceUsd: e.btc_price_usd,
    executedTimestamp: Number(e.executed_timestamp),
    executedTxHash: e.executed_tx_hash,
  }));

  // ── BTC/USD preview ────────────────────────────────────────────────────────
  const { data: btcPriceRaw } = useReadContract({
    abi,
    address: CONTRACT_ADDRESS,
    functionName: "get_btc_usd_price",
    args: [],
    watch: true,
    refetchInterval: 30000,
  });
  const btcUsd = btcPriceRaw ? Number((btcPriceRaw as any)[0]) / 1e8 : null;

  // ── USDC address lookup ────────────────────────────────────────────────────
  const { data: usdcAddressRaw } = useReadContract({
    abi,
    address: CONTRACT_ADDRESS,
    functionName: "usdc_address",
    args: [],
  });

  const now = Math.floor(Date.now() / 1000);
  const effectiveInterval = customInterval
    ? Number(customInterval)
    : intervalSecs;
  const effectiveExecs = customExec ? Number(customExec) : executions;
  const totalUsdcNeeded = usdcAmount
    ? (Number(usdcAmount) * effectiveExecs).toFixed(2)
    : null;
  const wbtcPreview =
    btcUsd && usdcAmount
      ? ((Number(usdcAmount) / btcUsd) * 1e8).toFixed(0) + " sat"
      : null;

  // ── Approve USDC ──────────────────────────────────────────────────────────
  const handleApprove = async () => {
    if (!account || !address || !usdcAddressRaw) {
      toast.error("Connect wallet first.");
      return;
    }
    if (!usdcAmount || Number(usdcAmount) <= 0) {
      toast.error("Enter USDC amount per interval.");
      return;
    }

    setApproving(true);
    const toastId = toast.loading("Approving USDC…");
    try {
      const usdcAddr = "0x" + BigInt(usdcAddressRaw.toString()).toString(16);
      // Approve total needed: usdcPerInterval * executions + 1% buffer
      const totalRaw = BigInt(
        Math.ceil(Number(usdcAmount) * effectiveExecs * 1e6),
      );
      const withBuffer = totalRaw + totalRaw / 100n;
      const amountU256 = uint256.bnToUint256(withBuffer);

      const allowanceResult = await account.callContract({
        contractAddress: usdcAddr,
        entrypoint: "allowance",
        calldata: CallData.compile([address, CONTRACT_ADDRESS]),
      });
      const currentAllowance = uint256.uint256ToBN({
        low: allowanceResult[0],
        high: allowanceResult[1],
      });
      if (currentAllowance >= withBuffer) {
        toast.update(toastId, {
          render: "Allowance already sufficient.",
          isLoading: false,
          type: "info",
          autoClose: 3000,
        });
        return;
      }

      const tx = await account.execute([
        {
          contractAddress: usdcAddr,
          entrypoint: "approve",
          calldata: CallData.compile([CONTRACT_ADDRESS, amountU256]),
        } as Call,
      ]);
      await account.waitForTransaction(tx.transaction_hash);
      toast.update(toastId, {
        render: "USDC approved!",
        isLoading: false,
        type: "success",
        autoClose: 4000,
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
      setApproving(false);
    }
  };

  // ── Create DCA order ──────────────────────────────────────────────────────
  const handleCreate = async () => {
    if (!account || !contract || !address)
      return toast.error("Connect wallet.");
    if (!usdcAmount || Number(usdcAmount) <= 0)
      return toast.error("Enter USDC amount.");
    if (!recipient.trim()) return toast.error("Enter wBTC recipient address.");

    setCreating(true);
    const toastId = toast.loading("Creating DCA order…");
    try {
      const usdcRaw = uint256.bnToUint256(
        BigInt(Math.round(Number(usdcAmount) * 1e6)),
      );

      const populate = contract.populate("start_dca", [
        usdcRaw,
        recipient.trim(),
        effectiveInterval,
        effectiveExecs,
      ]);

      await account.estimateInvokeFee([populate]);
      const tx = await account.execute([populate]);
      const receipt = await account.waitForTransaction(tx.transaction_hash);
      assertReceiptSuccess(receipt);

      toast.update(toastId, {
        render: `DCA order created! Buying ~${wbtcPreview ?? "wBTC"} every ${fmtInterval(effectiveInterval)} × ${effectiveExecs}`,
        isLoading: false,
        type: "success",
        autoClose: 6000,
      });

      // Reset form
      setUsdcAmount("");
      setRecipient("");
      setCustomInterval("");
      setCustomExec("");
      refetchOrders();
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
      setCreating(false);
    }
  };

  // ── Cancel DCA order ──────────────────────────────────────────────────────
  const handleCancel = async (orderId: string) => {
    if (!account || !contract) return;
    setCancelling(orderId);
    const toastId = toast.loading("Cancelling DCA order…");
    try {
      const orderIdU256 = uint256.bnToUint256(BigInt(orderId));
      const populate = contract.populate("cancel_dca", [orderIdU256]);
      await account.estimateInvokeFee([populate]);
      const tx = await account.execute([populate]);
      const receipt = await account.waitForTransaction(tx.transaction_hash);
      assertReceiptSuccess(receipt);
      toast.update(toastId, {
        render: "DCA order cancelled.",
        isLoading: false,
        type: "success",
        autoClose: 4000,
      });
      setHiddenOrders((prev) => new Set([...prev, orderId]));
      if (expandedOrderId === orderId) setExpandedOrderId(null);
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
      setCancelling(null);
    }
  };

  const canCreate =
    !!address &&
    !!usdcAmount &&
    Number(usdcAmount) > 0 &&
    !!recipient.trim() &&
    !creating;

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: "1rem" }}>
      {/* Info banner */}
      <div style={infoBox}>
        <RiLoopLeftLine
          size={14}
          color="#ffc800"
          style={{ flexShrink: 0, marginTop: 2 }}
        />
        <div style={{ fontSize: "0.68rem", color: "#555", lineHeight: 1.8 }}>
          Schedule recurring USDC → wBTC purchases at the live oracle price. A
          keeper calls <span style={{ color: "#ffc800" }}>execute_dca</span> on
          your behalf each interval. Remaining USDC stays in the contract until
          the next execution.
        </div>
      </div>

      {/* ── Create form ─────────────────────────────────────────────────── */}
      <div style={section}>
        <div style={sectionLabel}>New DCA order</div>

        {/* USDC per interval */}
        <div>
          <div style={fieldLabel}>USDC per execution</div>
          <div style={{ position: "relative" }}>
            <input
              value={usdcAmount}
              onChange={(e) => setUsdcAmount(e.target.value)}
              placeholder="e.g. 10"
              type="number"
              min="0"
              style={{ ...inputStyle, paddingRight: "3rem" }}
            />
            <span
              style={{
                position: "absolute",
                right: "0.9rem",
                top: "50%",
                transform: "translateY(-50%)",
                color: "#3a3a4a",
                fontSize: "0.7rem",
                fontFamily: "'DM Mono', monospace",
                pointerEvents: "none",
              }}
            >
              USDC
            </span>
          </div>
          {wbtcPreview && (
            <div
              style={{
                color: "#3a3a4a",
                fontSize: "0.62rem",
                marginTop: "0.3rem",
              }}
            >
              ≈ <span style={{ color: "#ffc800" }}>{wbtcPreview}</span> at
              current BTC price (
              {btcUsd ? fmtPrice((btcUsd * 1e8).toFixed(0)) : "—"})
            </div>
          )}
        </div>

        {/* Interval */}
        <div>
          <div style={fieldLabel}>Interval</div>
          <div style={{ display: "flex", gap: "0.4rem", flexWrap: "wrap" }}>
            {INTERVAL_PRESETS.map(({ label, secs }) => (
              <button
                key={secs}
                onClick={() => {
                  setIntervalSecs(secs);
                  setCustomInterval("");
                }}
                style={chip(effectiveInterval === secs && !customInterval)}
              >
                {label}
              </button>
            ))}
            <input
              value={customInterval}
              onChange={(e) => setCustomInterval(e.target.value)}
              placeholder="Custom (s)"
              type="number"
              style={{
                ...inputStyle,
                width: 110,
                padding: "0.4rem 0.7rem",
                fontSize: "0.7rem",
              }}
            />
          </div>
        </div>

        {/* Number of executions */}
        <div>
          <div style={fieldLabel}>Number of executions</div>
          <div
            style={{
              display: "flex",
              gap: "0.4rem",
              flexWrap: "wrap",
              alignItems: "center",
            }}
          >
            {EXECUTIONS_PRESETS.map((n) => (
              <button
                key={n}
                onClick={() => {
                  setExecutions(n);
                  setCustomExec("");
                }}
                style={chip(effectiveExecs === n && !customExec)}
              >
                {n}×
              </button>
            ))}
            <input
              value={customExec}
              onChange={(e) => setCustomExec(e.target.value)}
              placeholder="Custom"
              type="number"
              style={{
                ...inputStyle,
                width: 90,
                padding: "0.4rem 0.7rem",
                fontSize: "0.7rem",
              }}
            />
          </div>
          {totalUsdcNeeded && (
            <div
              style={{
                color: "#3a3a4a",
                fontSize: "0.62rem",
                marginTop: "0.3rem",
              }}
            >
              Total USDC to approve:{" "}
              <span style={{ color: "#aaa" }}>${totalUsdcNeeded}</span>
            </div>
          )}
        </div>

        {/* wBTC recipient */}
        <div>
          <div style={fieldLabel}>wBTC recipient</div>
          <input
            value={recipient}
            onChange={(e) => setRecipient(e.target.value)}
            placeholder="0x… address to receive wBTC"
            style={inputStyle}
          />
          {address && !recipient && (
            <button
              onClick={() => setRecipient(address)}
              style={{ ...btnGhost, marginTop: "0.4rem" }}
            >
              Use connected wallet
            </button>
          )}
        </div>

        {/* Summary */}
        {usdcAmount && Number(usdcAmount) > 0 && (
          <div
            style={{
              background: "#0a0a0f",
              border: "1px solid #1e1e2e",
              borderRadius: 8,
              padding: "0.85rem 1rem",
              display: "flex",
              flexDirection: "column",
              gap: "0.35rem",
            }}
          >
            <SummaryRow
              label="Spend"
              value={`${fmtUsdc((Number(usdcAmount) * 1e6).toFixed(0))} every ${fmtInterval(effectiveInterval)}`}
            />
            <SummaryRow label="Executions" value={`${effectiveExecs}×`} />
            <SummaryRow
              label="Duration"
              value={fmtInterval(effectiveInterval * effectiveExecs)}
            />
            <SummaryRow
              label="Total USDC"
              value={`$${totalUsdcNeeded}`}
              highlight
            />
          </div>
        )}

        {/* Approve + Create buttons */}
        <div
          style={{
            display: "grid",
            gridTemplateColumns: "1fr 1fr",
            gap: "0.6rem",
          }}
        >
          <button
            onClick={handleApprove}
            disabled={approving || !address || !usdcAmount}
            style={btnPrimary(!approving && !!address && !!usdcAmount)}
          >
            {approving ? (
              <>
                <FaSpinner
                  size={12}
                  style={{ animation: "spin 1s linear infinite" }}
                />{" "}
                Approving…
              </>
            ) : (
              "1. Approve USDC"
            )}
          </button>
          <button
            onClick={handleCreate}
            disabled={!canCreate}
            style={btnPrimary(canCreate)}
          >
            {creating ? (
              <>
                <FaSpinner
                  size={12}
                  style={{ animation: "spin 1s linear infinite" }}
                />{" "}
                Creating…
              </>
            ) : (
              <>
                <RiAddLine size={13} /> 2. Create Order
              </>
            )}
          </button>
        </div>
      </div>

      {/* ── Active orders ────────────────────────────────────────────────── */}
      <div style={section}>
        <div
          style={{
            display: "flex",
            justifyContent: "space-between",
            alignItems: "center",
          }}
        >
          <div style={sectionLabel}>Your active orders</div>
          <button
            onClick={() => refetchOrders()}
            disabled={ordersLoading}
            style={{
              ...btnGhost,
              width: "auto",
              padding: "0.3rem 0.7rem",
              fontSize: "0.62rem",
            }}
          >
            {ordersLoading ? (
              <FaSpinner
                size={10}
                style={{ animation: "spin 1s linear infinite" }}
              />
            ) : (
              <FaSync size={10} />
            )}
            &nbsp;Refresh
          </button>
        </div>

        {!address && (
          <div style={emptyState}>Connect wallet to see your orders</div>
        )}
        {address && ordersLoading && (
          <div
            style={{
              display: "flex",
              alignItems: "center",
              gap: "0.5rem",
              color: "#3a3a4a",
              fontSize: "0.68rem",
            }}
          >
            <FaSpinner
              size={11}
              style={{ animation: "spin 1s linear infinite" }}
            />
            Loading from indexer…
          </div>
        )}
        {address && !ordersLoading && orders.length === 0 && (
          <div style={emptyState}>No active DCA orders</div>
        )}

        {orders.map((order) => {
          const isExpanded = expandedOrderId === order.orderId;
          const isDone = order.executionsLeft === 0;
          const isReady = order.nextExecution <= now;
          const isCancellingThis = cancelling === order.orderId;

          return (
            <div
              key={order.orderId}
              style={{
                border: `1px solid ${isExpanded ? "rgba(255,200,0,0.3)" : "#1e1e2e"}`,
                borderRadius: 8,
                overflow: "hidden",
                transition: "border-color 0.15s",
              }}
            >
              {/* Order header row */}
              <div
                onClick={() =>
                  setExpandedOrderId(isExpanded ? null : order.orderId)
                }
                style={{
                  background: isExpanded ? "rgba(255,200,0,0.04)" : "#0a0a0f",
                  padding: "0.85rem 1rem",
                  display: "flex",
                  justifyContent: "space-between",
                  alignItems: "center",
                  cursor: "pointer",
                  transition: "background 0.15s",
                }}
              >
                <div
                  style={{
                    display: "flex",
                    flexDirection: "column",
                    gap: "0.2rem",
                  }}
                >
                  <div
                    style={{
                      display: "flex",
                      alignItems: "center",
                      gap: "0.5rem",
                    }}
                  >
                    <FaBitcoin size={11} color="#f7931a" />
                    <span
                      style={{
                        color: "#fff",
                        fontSize: "0.82rem",
                        fontWeight: 700,
                      }}
                    >
                      {fmtUsdc(order.usdcPerInterval)} /{" "}
                      {fmtInterval(order.intervalSeconds)}
                    </span>
                  </div>
                  <div style={{ color: "#3a3a4a", fontSize: "0.6rem" }}>
                    {order.executionsLeft}/{order.executionsTotal} remaining ·
                    next:{" "}
                    <span style={{ color: isReady ? "#22c55e" : "#555" }}>
                      {isReady ? "now" : fmtCountdown(order.nextExecution, now)}
                    </span>
                  </div>
                </div>

                <div
                  style={{
                    display: "flex",
                    alignItems: "center",
                    gap: "0.6rem",
                  }}
                >
                  {/* Progress bar */}
                  <div
                    style={{
                      width: 60,
                      height: 4,
                      background: "#1e1e2e",
                      borderRadius: 2,
                      overflow: "hidden",
                    }}
                  >
                    <div
                      style={{
                        height: "100%",
                        width: `${((order.executionsTotal - order.executionsLeft) / order.executionsTotal) * 100}%`,
                        background: "#ffc800",
                        borderRadius: 2,
                        transition: "width 0.3s",
                      }}
                    />
                  </div>
                  <FaChevronDown
                    size={10}
                    color="#3a3a4a"
                    style={{
                      transform: isExpanded ? "rotate(180deg)" : "rotate(0deg)",
                      transition: "transform 0.2s",
                    }}
                  />
                </div>
              </div>

              {/* Expanded details */}
              {isExpanded && (
                <div
                  style={{
                    padding: "0.85rem 1rem",
                    borderTop: "1px solid #1e1e2e",
                    display: "flex",
                    flexDirection: "column",
                    gap: "0.7rem",
                  }}
                >
                  {/* Details grid */}
                  <div
                    style={{
                      display: "flex",
                      flexDirection: "column",
                      gap: "0.35rem",
                    }}
                  >
                    <DetailRow
                      label="Order ID"
                      value={order.orderId.slice(0, 14) + "…"}
                    />
                    <DetailRow
                      label="wBTC recipient"
                      value={
                        order.usdcRecipient.slice(0, 10) +
                        "…" +
                        order.usdcRecipient.slice(-6)
                      }
                    />
                    <DetailRow
                      label="Interval"
                      value={fmtInterval(order.intervalSeconds)}
                    />
                    <DetailRow
                      label="Next execution"
                      value={
                        order.nextExecution <= now
                          ? "Ready for keeper"
                          : fmtDate(order.nextExecution)
                      }
                    />
                    {wbtcPreview && (
                      <DetailRow
                        label="≈ wBTC/exec"
                        value={
                          btcUsd
                            ? (
                                (Number(order.usdcPerInterval) / 1e6 / btcUsd) *
                                1e8
                              ).toFixed(0) + " sat"
                            : "—"
                        }
                      />
                    )}
                  </div>

                  {/* Execution history */}
                  {execLoading && expandedOrderId === order.orderId && (
                    <div
                      style={{
                        display: "flex",
                        alignItems: "center",
                        gap: "0.5rem",
                        color: "#3a3a4a",
                        fontSize: "0.65rem",
                      }}
                    >
                      <FaSpinner
                        size={10}
                        style={{ animation: "spin 1s linear infinite" }}
                      />
                      Loading history…
                    </div>
                  )}

                  {executions_history.length > 0 &&
                    expandedOrderId === order.orderId && (
                      <div>
                        <div style={{ ...fieldLabel, marginBottom: "0.5rem" }}>
                          Execution history
                        </div>
                        <div
                          style={{
                            display: "flex",
                            flexDirection: "column",
                            gap: "0.3rem",
                          }}
                        >
                          {executions_history.map((e) => (
                            <div
                              key={e.executionNumber}
                              style={{
                                background: "#0a0a0f",
                                border: "1px solid #1e1e2e",
                                borderRadius: 6,
                                padding: "0.6rem 0.8rem",
                                display: "flex",
                                justifyContent: "space-between",
                                alignItems: "center",
                              }}
                            >
                              <div>
                                <div
                                  style={{
                                    color: "#aaa",
                                    fontSize: "0.7rem",
                                    fontWeight: 700,
                                  }}
                                >
                                  #{e.executionNumber} —{" "}
                                  {fmtSats(e.wbtcReceived)}
                                </div>
                                <div
                                  style={{
                                    color: "#3a3a4a",
                                    fontSize: "0.6rem",
                                    marginTop: "0.1rem",
                                  }}
                                >
                                  {fmtUsdc(e.usdcSpent)} spent · BTC @{" "}
                                  {fmtPrice(e.btcPriceUsd)}
                                </div>
                              </div>
                              <div
                                style={{
                                  color: "#2a2a3a",
                                  fontSize: "0.6rem",
                                  textAlign: "right",
                                }}
                              >
                                {e.executedTimestamp
                                  ? fmtDate(e.executedTimestamp)
                                  : "—"}
                              </div>
                            </div>
                          ))}
                        </div>

                        {/* Avg cost basis */}
                        {executions_history.length > 1 &&
                          (() => {
                            const totalUsdc = executions_history.reduce(
                              (a, e) => a + Number(e.usdcSpent),
                              0,
                            );
                            const totalSats = executions_history.reduce(
                              (a, e) => a + Number(e.wbtcReceived),
                              0,
                            );
                            const avgPrice =
                              totalSats > 0
                                ? totalUsdc / 1e6 / (totalSats / 1e8)
                                : null;
                            return avgPrice ? (
                              <div
                                style={{
                                  background: "rgba(255,200,0,0.04)",
                                  border: "1px solid rgba(255,200,0,0.12)",
                                  borderRadius: 6,
                                  padding: "0.6rem 0.8rem",
                                  fontSize: "0.65rem",
                                  color: "#555",
                                  marginTop: "0.25rem",
                                }}
                              >
                                Avg cost basis:{" "}
                                <span
                                  style={{ color: "#ffc800", fontWeight: 700 }}
                                >
                                  $
                                  {avgPrice.toLocaleString(undefined, {
                                    maximumFractionDigits: 0,
                                  })}{" "}
                                  / BTC
                                </span>
                              </div>
                            ) : null;
                          })()}
                      </div>
                    )}

                  {/* Cancel button */}
                  {!isDone && (
                    <button
                      onClick={(e) => {
                        e.stopPropagation();
                        handleCancel(order.orderId);
                      }}
                      disabled={isCancellingThis}
                      style={{
                        background: "transparent",
                        color: isCancellingThis ? "#2a2a3a" : "#f87171",
                        border: `1px solid ${isCancellingThis ? "#1e1e2e" : "rgba(248,113,113,0.3)"}`,
                        borderRadius: 7,
                        padding: "0.6rem",
                        fontSize: "0.68rem",
                        fontFamily: "'DM Mono', monospace",
                        cursor: isCancellingThis ? "not-allowed" : "pointer",
                        display: "flex",
                        alignItems: "center",
                        justifyContent: "center",
                        gap: "0.4rem",
                        transition: "all 0.15s",
                        width: "100%",
                      }}
                    >
                      {isCancellingThis ? (
                        <>
                          <FaSpinner
                            size={11}
                            style={{ animation: "spin 1s linear infinite" }}
                          />{" "}
                          Cancelling…
                        </>
                      ) : (
                        <>
                          <RiCloseLine size={13} /> Cancel order
                        </>
                      )}
                    </button>
                  )}
                </div>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}

// ── Sub-components ────────────────────────────────────────────────────────────

function SummaryRow({
  label,
  value,
  highlight,
}: {
  label: string;
  value: string | null;
  highlight?: boolean;
}) {
  return (
    <div style={{ display: "flex", justifyContent: "space-between" }}>
      <span style={{ color: "#2a2a3a", fontSize: "0.62rem" }}>{label}</span>
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

function DetailRow({ label, value }: { label: string; value: string }) {
  return (
    <div style={{ display: "flex", justifyContent: "space-between" }}>
      <span style={{ color: "#3a3a4a", fontSize: "0.62rem" }}>{label}</span>
      <span
        style={{
          color: "#aaa",
          fontSize: "0.62rem",
          fontFamily: "'DM Mono', monospace",
        }}
      >
        {value}
      </span>
    </div>
  );
}

// ── Styles ────────────────────────────────────────────────────────────────────

const section: React.CSSProperties = {
  background: "#111118",
  border: "1px solid #1e1e2e",
  borderRadius: 10,
  padding: "1.1rem 1.2rem",
  display: "flex",
  flexDirection: "column",
  gap: "0.75rem",
};
const sectionLabel: React.CSSProperties = {
  color: "#3a3a4a",
  fontSize: "0.6rem",
  letterSpacing: "0.15em",
  textTransform: "uppercase",
};
const fieldLabel: React.CSSProperties = {
  color: "#2a2a3a",
  fontSize: "0.6rem",
  letterSpacing: "0.1em",
  textTransform: "uppercase",
  marginBottom: "0.35rem",
};
const emptyState: React.CSSProperties = {
  color: "#2a2a3a",
  fontSize: "0.68rem",
  textAlign: "center",
  padding: "1rem 0",
  letterSpacing: "0.06em",
};
const infoBox: React.CSSProperties = {
  display: "flex",
  alignItems: "flex-start",
  gap: "0.75rem",
  background: "rgba(255,200,0,0.04)",
  border: "1px solid rgba(255,200,0,0.1)",
  borderRadius: 10,
  padding: "1rem",
};
const chip = (active: boolean): React.CSSProperties => ({
  background: active ? "#ffc800" : "transparent",
  color: active ? "#0a0a0f" : "#555",
  border: `1px solid ${active ? "#ffc800" : "#2a2a3a"}`,
  borderRadius: 6,
  padding: "0.35rem 0.7rem",
  fontSize: "0.7rem",
  fontFamily: "'DM Mono', monospace",
  fontWeight: active ? 900 : 400,
  cursor: "pointer",
  transition: "all 0.15s",
});
