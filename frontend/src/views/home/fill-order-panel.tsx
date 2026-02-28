import React, { useState } from "react";
import { toast } from "react-toastify";
import { useAccount, useContract } from "@starknet-react/core";
import { CallData, uint256, type Call } from "starknet";
import { FaSpinner, FaSearch, FaSync } from "react-icons/fa";
import { RiTimeLine, RiExchangeLine } from "react-icons/ri";
import { useQuery } from "@apollo/client";
import abi from "../../assets/json/abi";
import { CONTRACT_ADDRESS } from "../../utils/constants";
import { GET_OPEN_WBTC_ORDERS } from "../../graphql/queries";
import { btnPrimary, btnGhost, inputStyle } from "./shared";
import { assertReceiptSuccess } from "../../utils/helpers";

interface OpenOrder {
  orderId: string;
  wbtcSeller: string;
  aliceStrkDest: string;
  wbtcAmount: string;
  quotedStrkAmount: string;
  hashlock: string;
  expiry: number;
  rateExpiry: number;
}

const EXPIRY_PRESETS = [
  { label: "1h", secs: 3600 },
  { label: "2h", secs: 7200 },
  { label: "4h", secs: 14400 },
  { label: "8h", secs: 28800 },
];

export default function FillOrderPanel() {
  const { address, account } = useAccount();
  const { contract } = useContract({ abi, address: CONTRACT_ADDRESS });
  const [manualOrderId, setManualOrderId] = useState("");
  const [selectedOrder, setSelectedOrder] = useState<OpenOrder | null>(null);
  const [bobExpirySeconds, setBobExpirySeconds] = useState(3600);
  const [approveLoading, setApproveLoading] = useState(false);
  const [fillLoading, setFillLoading] = useState(false);
  const [fillStep, setFillStep] = useState<
    "idle" | "approve" | "fill" | "done"
  >("idle");

  const now = Math.floor(Date.now() / 1000);

  // ── Indexer query replaces provider.getEvents + contract.call loop ──────────
  const {
    data,
    loading: loadingOrders,
    refetch,
  } = useQuery(GET_OPEN_WBTC_ORDERS, { fetchPolicy: "network-only" });

  // Filter client-side: remove expired orders
  const orders: OpenOrder[] = (data?.wbtcorders ?? [])
    .filter((o: any) => Number(o.expiry) > now)
    .map((o: any) => ({
      orderId: o.id,
      wbtcSeller: o.wbtc_seller,
      aliceStrkDest: o.alice_strk_destination,
      wbtcAmount: o.wbtc_amount,
      quotedStrkAmount: o.quoted_strk_amount,
      hashlock: o.hashlock,
      expiry: Number(o.expiry),
      rateExpiry: Number(o.rate_expiry),
    }));

  // ── Manual order lookup still uses contract directly ─────────────────────────
  const lookupOrder = async () => {
    if (!contract || !manualOrderId.trim()) return;
    try {
      const orderData = (await contract.call("get_wbtc_order", [
        uint256.bnToUint256(BigInt(manualOrderId.trim())),
      ])) as any;
      const nowTs = Math.floor(Date.now() / 1000);
      if (Number(orderData.expiry) < nowTs)
        return toast.error("Order has expired.");
      if (orderData.is_filled) return toast.error("Order already filled.");

      setSelectedOrder({
        orderId: manualOrderId.trim(),
        wbtcSeller: "0x" + BigInt(orderData.wbtc_seller).toString(16),
        aliceStrkDest:
          "0x" + BigInt(orderData.alice_strk_destination).toString(16),
        wbtcAmount: orderData.wbtc_amount.toString(),
        quotedStrkAmount: orderData.quoted_strk_amount.toString(),
        hashlock: "0x" + BigInt(orderData.hashlock).toString(16),
        expiry: Number(orderData.expiry),
        rateExpiry: Number(orderData.rate_expiry),
      });
      setFillStep("approve");
    } catch (err: any) {
      toast.error("Order not found: " + err?.message);
    }
  };

  const handleApprove = async () => {
    if (!account || !selectedOrder) return;
    setApproveLoading(true);
    try {
      const strkAddress = (await contract!.call("strk_address")) as any;
      const hexAddr = "0x" + BigInt(strkAddress.toString()).toString(16);

      const allowanceResult = await account.callContract({
        contractAddress: hexAddr,
        entrypoint: "allowance",
        calldata: CallData.compile([address, CONTRACT_ADDRESS]),
      });

      const currentAllowance = uint256.uint256ToBN({
        low: allowanceResult[0],
        high: allowanceResult[1],
      });

      const quoted = BigInt(selectedOrder.quotedStrkAmount);
      const required = quoted + quoted / 100n;

      if (currentAllowance >= required) {
        toast.info("Allowance already sufficient.");
        setFillStep("fill");
        return;
      }

      const callData = [CONTRACT_ADDRESS, required.toString(), "0"];

      const contractData: Call = {
        contractAddress: strkAddress.toString(),
        entrypoint: "approve",
        calldata: callData,
      };

      await account.estimateInvokeFee(contractData);
      const tx = await account.execute([contractData]);
      const receipt = await account.waitForTransaction(tx.transaction_hash);
      assertReceiptSuccess(receipt);
      toast.success("STRK approved!");
      setFillStep("fill");
    } catch (err: any) {
      const executionError =
        err?.baseError?.data?.execution_error?.error ??
        err?.message ??
        String(err);
      toast.error(executionError);
    } finally {
      setApproveLoading(false);
    }
  };

  const handleFill = async () => {
    if (!account || !contract || !selectedOrder) return;
    setFillLoading(true);
    try {
      const nowTs = Math.floor(Date.now() / 1000);
      const bobExpiry = nowTs + bobExpirySeconds;
      const orderIdU256 = uint256.bnToUint256(BigInt(selectedOrder.orderId));

      const populate = contract.populate("fill_wbtc_order", [
        orderIdU256,
        bobExpiry,
      ]);

      await account.estimateInvokeFee([populate]);

      const tx = await account.execute([populate]);
      const receipt = await account.waitForTransaction(tx.transaction_hash);
      assertReceiptSuccess(receipt);
      toast.success(
        "Order filled! Alice will reveal the secret — then claim your wBTC.",
      );
      setFillStep("done");
      // Invalidate the indexer cache so list refreshes
      refetch();
    } catch (err: any) {
      toast.error("Fill failed: " + err?.message);
    } finally {
      setFillLoading(false);
    }
  };

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: "1rem" }}>
      {/* Info */}
      <div style={infoBox}>
        <RiExchangeLine
          size={14}
          color="#ffc800"
          style={{ flexShrink: 0, marginTop: 2 }}
        />
        <div style={{ fontSize: "0.68rem", color: "#555", lineHeight: 1.8 }}>
          Browse open wBTC orders. Fill one by locking STRK. Once Alice reveals
          her secret, use <b style={{ color: "#aaa" }}>Manage Orders</b> to
          claim your wBTC.
        </div>
      </div>

      {/* Browse open orders */}
      <div style={section}>
        <div
          style={{
            display: "flex",
            justifyContent: "space-between",
            alignItems: "center",
          }}
        >
          <div style={sectionLabel}>Open orders</div>
          <button
            onClick={() => refetch()}
            disabled={loadingOrders}
            style={{
              ...btnGhost,
              width: "auto",
              padding: "0.3rem 0.75rem",
              fontSize: "0.65rem",
            }}
          >
            {loadingOrders ? (
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

        {loadingOrders ? (
          <div
            style={{
              textAlign: "center",
              color: "#3a3a4a",
              padding: "1.5rem",
              fontSize: "0.72rem",
            }}
          >
            <FaSpinner
              size={18}
              style={{
                animation: "spin 1s linear infinite",
                marginBottom: "0.5rem",
                display: "block",
                margin: "0 auto 0.5rem",
              }}
            />
            Loading from indexer…
          </div>
        ) : orders.length === 0 ? (
          <div
            style={{
              textAlign: "center",
              color: "#2a2a3a",
              padding: "1.5rem",
              fontSize: "0.72rem",
              letterSpacing: "0.08em",
            }}
          >
            No open orders found
          </div>
        ) : (
          <div
            style={{ display: "flex", flexDirection: "column", gap: "0.6rem" }}
          >
            {orders.map((o) => (
              <OrderCard
                key={o.orderId}
                order={o}
                now={now}
                selected={selectedOrder?.orderId === o.orderId}
                onSelect={() => {
                  setSelectedOrder(o);
                  setFillStep("approve");
                }}
              />
            ))}
          </div>
        )}
      </div>

      {/* Manual lookup */}
      <div style={section}>
        <div style={sectionLabel}>Or enter order ID manually</div>
        <div style={{ display: "flex", gap: "0.5rem" }}>
          <input
            value={manualOrderId}
            onChange={(e) => setManualOrderId(e.target.value)}
            placeholder="0x… order ID"
            style={{ ...inputStyle, flex: 1 }}
          />
          <button
            onClick={lookupOrder}
            style={{
              ...btnGhost,
              width: "auto",
              padding: "0.6rem 1rem",
              flexShrink: 0,
            }}
          >
            <FaSearch size={11} />
          </button>
        </div>
      </div>

      {/* Fill flow */}
      {selectedOrder && fillStep !== "done" && (
        <div
          style={{
            ...section,
            borderColor: "rgba(255,200,0,0.25)",
            background: "rgba(255,200,0,0.03)",
          }}
        >
          <div style={sectionLabel}>Selected order</div>
          <div style={detailGrid}>
            <Detail
              label="Order ID"
              value={selectedOrder.orderId.slice(0, 18) + "…"}
            />
            <Detail
              label="wBTC amount"
              value={Number(selectedOrder.wbtcAmount).toLocaleString() + " sat"}
            />
            <Detail
              label="STRK you lock"
              value={
                (Number(selectedOrder.quotedStrkAmount) / 1e18).toLocaleString(
                  undefined,
                  { maximumFractionDigits: 8 },
                ) + " STRK"
              }
              highlight
            />
            <Detail
              label="Expires"
              value={new Date(selectedOrder.expiry * 1000).toLocaleTimeString()}
            />
          </div>

          {/* Bob expiry */}
          <div style={sectionLabel}>Your expiry (must be &lt; Alice's)</div>
          <div style={{ display: "flex", gap: "0.5rem", flexWrap: "wrap" }}>
            {EXPIRY_PRESETS.filter(
              (p) => p.secs < selectedOrder.expiry - now,
            ).map(({ label, secs }) => (
              <button
                key={secs}
                onClick={() => setBobExpirySeconds(secs)}
                style={chipStyle(bobExpirySeconds === secs)}
              >
                {label}
              </button>
            ))}
          </div>
          <p style={{ color: "#3a3a4a", fontSize: "0.62rem", margin: 0 }}>
            <RiTimeLine style={{ verticalAlign: "middle" }} /> Your STRK is
            locked for {bobExpirySeconds / 3600}h. If Alice doesn't reveal in
            time, refund it.
          </p>

          <div
            style={{
              display: "grid",
              gridTemplateColumns: "1fr 1fr",
              gap: "0.6rem",
            }}
          >
            <button
              onClick={handleApprove}
              disabled={approveLoading || fillStep === "fill"}
              style={{
                ...btnPrimary(fillStep === "approve" && !approveLoading),
                opacity: fillStep === "fill" ? 0.4 : 1,
              }}
            >
              {approveLoading ? (
                <FaSpinner
                  size={12}
                  style={{ animation: "spin 1s linear infinite" }}
                />
              ) : null}
              {fillStep === "fill" ? "✓ Approved" : "1. Approve STRK"}
            </button>
            <button
              onClick={handleFill}
              disabled={fillLoading || fillStep !== "fill"}
              style={btnPrimary(fillStep === "fill" && !fillLoading)}
            >
              {fillLoading ? (
                <FaSpinner
                  size={12}
                  style={{ animation: "spin 1s linear infinite" }}
                />
              ) : null}
              2. Fill Order
            </button>
          </div>
        </div>
      )}

      {fillStep === "done" && (
        <div
          style={{
            ...infoBox,
            background: "rgba(255,200,0,0.06)",
            borderColor: "rgba(255,200,0,0.25)",
            padding: "1.5rem",
            flexDirection: "column",
          }}
        >
          <div
            style={{ color: "#ffc800", fontWeight: 900, fontSize: "0.9rem" }}
          >
            🎉 Order filled!
          </div>
          <div
            style={{
              color: "#555",
              fontSize: "0.68rem",
              marginTop: "0.4rem",
              lineHeight: 1.7,
            }}
          >
            Your STRK is locked. Alice will reveal the secret to claim her STRK.
            Once the secret is public, go to{" "}
            <b style={{ color: "#aaa" }}>Manage Orders</b> and paste your STRK
            order ID to claim your wBTC.
          </div>
        </div>
      )}
    </div>
  );
}

// ── Sub-components ────────────────────────────────────────────────────────────

function OrderCard({
  order,
  now,
  selected,
  onSelect,
}: {
  order: OpenOrder;
  now: number;
  selected: boolean;
  onSelect: () => void;
}) {
  const remainMins = Math.floor((order.expiry - now) / 60);
  const rateExpired = now > order.rateExpiry;
  return (
    <button
      onClick={onSelect}
      style={{
        background: selected ? "rgba(255,200,0,0.08)" : "#0a0a0f",
        border: `1px solid ${selected ? "rgba(255,200,0,0.4)" : "#1e1e2e"}`,
        borderRadius: 8,
        padding: "0.9rem 1rem",
        display: "flex",
        justifyContent: "space-between",
        alignItems: "center",
        cursor: "pointer",
        transition: "all 0.15s",
        width: "100%",
        textAlign: "left",
      }}
    >
      <div>
        <div
          style={{ color: "#555", fontSize: "0.62rem", marginBottom: "0.2rem" }}
        >
          Seller: {order.wbtcSeller.slice(0, 8)}…{order.wbtcSeller.slice(-4)}
        </div>
        <div style={{ color: "#fff", fontSize: "0.8rem", fontWeight: 700 }}>
          {Number(order.wbtcAmount).toLocaleString()} sat
        </div>
      </div>
      <div style={{ textAlign: "right" }}>
        <div style={{ color: "#ffc800", fontSize: "0.82rem", fontWeight: 700 }}>
          {(Number(order.quotedStrkAmount) / 1e18).toLocaleString(undefined, {
            maximumFractionDigits: 8,
          })}
          STRK
        </div>
        <div
          style={{
            color: rateExpired ? "#f87171" : "#3a3a4a",
            fontSize: "0.6rem",
            marginTop: "0.2rem",
          }}
        >
          {rateExpired ? "⚠ rate expired" : `${remainMins}m remaining`}
        </div>
      </div>
    </button>
  );
}

function Detail({
  label,
  value,
  highlight,
}: {
  label: string;
  value: string;
  highlight?: boolean;
}) {
  return (
    <div style={{ display: "flex", justifyContent: "space-between" }}>
      <span style={{ color: "#3a3a4a", fontSize: "0.62rem" }}>{label}</span>
      <span
        style={{
          color: highlight ? "#ffc800" : "#aaa",
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
  gap: "0.65rem",
};
const sectionLabel: React.CSSProperties = {
  color: "#3a3a4a",
  fontSize: "0.6rem",
  letterSpacing: "0.15em",
  textTransform: "uppercase",
};
const detailGrid: React.CSSProperties = {
  display: "flex",
  flexDirection: "column",
  gap: "0.45rem",
  background: "#0a0a0f",
  borderRadius: 8,
  padding: "0.8rem",
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
