import React, { useState, useEffect, useCallback } from "react";
import { toast } from "react-toastify";
import { useAccount, useContract } from "@starknet-react/core";
import { uint256, type Call } from "starknet";
import { FaSpinner, FaUpload, FaSync } from "react-icons/fa";
import {
  RiArrowRightLine,
  RiRefund2Line,
  RiMoneyDollarCircleLine,
} from "react-icons/ri";
import { useQuery } from "@apollo/client";
import abi from "../../assets/json/abi";
import { CONTRACT_ADDRESS, U128_MAX } from "../../utils/constants";
import {
  GET_CLAIMABLE_STRK_ORDERS,
  GET_FILLED_WBTC_ORDERS_FOR_BUYER,
  GET_REFUNDABLE_WBTC_ORDERS,
  GET_REFUNDABLE_STRK_ORDERS,
} from "../../graphql/queries";
import { btnPrimary, inputStyle, btnGhost } from "./shared";
import { assertReceiptSuccess } from "../../utils/helpers";

// ── Types ─────────────────────────────────────────────────────────────────────

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

interface ClaimableStrkOrder {
  strkOrderId: string;
  wbtcOrderId: string;
  strkAmount: string;
  expiry: number;
  hashlock: string;
}

interface ClaimableWbtcOrder {
  wbtcOrderId: string;
  wbtcAmount: string;
  expiry: number;
}

interface RefundableWbtcOrder {
  wbtcOrderId: string;
  wbtcAmount: string;
  expiry: number;
}

interface RefundableStrkOrder {
  strkOrderId: string;
  strkAmount: string;
  expiry: number;
}

function toHex(raw: bigint | string) {
  return "0x" + BigInt(raw).toString(16);
}

// Addresses are stored zero-padded to 64 hex chars in the indexer
function toHexAddr(raw: bigint | string) {
  return "0x" + BigInt(raw).toString(16).padStart(64, "0");
}

// ── Custom hooks (Apollo-backed) ──────────────────────────────────────────────

function useClaimableStrkOrders(active: boolean) {
  const { account } = useAccount();
  const now = Math.floor(Date.now() / 1000);

  const myAddr = account?.address ? toHexAddr(account.address) : "";

  const {
    data,
    loading: scanning,
    refetch,
  } = useQuery(GET_CLAIMABLE_STRK_ORDERS, {
    variables: { buyer: myAddr, now },
    skip: !myAddr || !active,
    fetchPolicy: "network-only",
  });

  const orders: ClaimableStrkOrder[] = (data?.strkorders ?? []).map(
    (o: any) => ({
      strkOrderId: o.id,
      wbtcOrderId: o.wbtc_order_id ?? "",
      strkAmount: o.strk_amount,
      expiry: Number(o.expiry),
      hashlock: o.hashlock,
    }),
  );

  // Optimistic remove after action
  const [hidden, setHidden] = useState<Set<string>>(new Set());
  const remove = (id: string) => setHidden((prev) => new Set([...prev, id]));
  const visibleOrders = orders.filter((o) => !hidden.has(o.strkOrderId));

  return { orders: visibleOrders, scanning, scan: refetch, remove };
}

function useClaimableWbtcOrders(active: boolean) {
  const { account } = useAccount();
  const { contract } = useContract({ abi, address: CONTRACT_ADDRESS });

  const myAddr = account?.address ? toHexAddr(account.address) : "";

  // Fetch candidates from indexer (is_filled=true, buyer=me, not withdrawn)
  const { data, loading, refetch } = useQuery(
    GET_FILLED_WBTC_ORDERS_FOR_BUYER,
    {
      variables: { buyer: myAddr },
      skip: !myAddr || !active,
      fetchPolicy: "network-only",
    },
  );

  // Secret-revealed check requires a contract call because `secret` is not
  // indexed. We run the check lazily and cache results.
  const [secretChecked, setSecretChecked] = useState<Map<string, boolean>>(
    new Map(),
  );
  const [checking, setChecking] = useState(false);

  const candidates: {
    wbtcOrderId: string;
    wbtcAmount: string;
    expiry: number;
  }[] = (data?.wbtcorders ?? []).map((o: any) => ({
    wbtcOrderId: o.id,
    wbtcAmount: o.wbtc_amount,
    expiry: Number(o.expiry),
  }));

  // Check secrets whenever candidates list changes
  useEffect(() => {
    if (!contract || candidates.length === 0) return;

    const unchecked = candidates.filter(
      (c) => !secretChecked.has(c.wbtcOrderId),
    );
    if (unchecked.length === 0) return;

    setChecking(true);
    Promise.all(
      unchecked.map(async (c) => {
        try {
          const o = (await contract.call("get_wbtc_order", [
            uint256.bnToUint256(BigInt(c.wbtcOrderId)),
          ])) as any;
          return { id: c.wbtcOrderId, revealed: BigInt(o.secret ?? 0) !== 0n };
        } catch {
          return { id: c.wbtcOrderId, revealed: false };
        }
      }),
    ).then((results) => {
      setSecretChecked((prev) => {
        const next = new Map(prev);
        results.forEach((r) => next.set(r.id, r.revealed));
        return next;
      });
      setChecking(false);
    });
  }, [candidates.length, contract]); // eslint-disable-line react-hooks/exhaustive-deps

  const orders: ClaimableWbtcOrder[] = candidates.filter(
    (c) => secretChecked.get(c.wbtcOrderId) === true,
  );

  const [hidden, setHidden] = useState<Set<string>>(new Set());
  const remove = (id: string) => setHidden((prev) => new Set([...prev, id]));
  const visibleOrders = orders.filter((o) => !hidden.has(o.wbtcOrderId));

  const scan = useCallback(async () => {
    setSecretChecked(new Map());
    await refetch();
  }, [refetch]);

  return {
    orders: visibleOrders,
    scanning: loading || checking,
    scan,
    remove,
  };
}

function useRefundableWbtcOrders(active: boolean) {
  const { account } = useAccount();
  const now = Math.floor(Date.now() / 1000);
  const myAddr = account?.address ? toHexAddr(account.address) : "";

  const {
    data,
    loading: scanning,
    refetch,
  } = useQuery(GET_REFUNDABLE_WBTC_ORDERS, {
    variables: { seller: myAddr, now },
    skip: !myAddr || !active,
    fetchPolicy: "network-only",
  });

  const orders: RefundableWbtcOrder[] = (data?.wbtcorders ?? []).map(
    (o: any) => ({
      wbtcOrderId: o.id,
      wbtcAmount: o.wbtc_amount,
      expiry: Number(o.expiry),
    }),
  );

  const [hidden, setHidden] = useState<Set<string>>(new Set());
  const remove = (id: string) => setHidden((prev) => new Set([...prev, id]));
  const visibleOrders = orders.filter((o) => !hidden.has(o.wbtcOrderId));

  return { orders: visibleOrders, scanning, scan: refetch, remove };
}

function useRefundableStrkOrders(active: boolean) {
  const { account } = useAccount();
  const now = Math.floor(Date.now() / 1000);
  const myAddr = account?.address ? toHexAddr(account.address) : "";

  const {
    data,
    loading: scanning,
    refetch,
  } = useQuery(GET_REFUNDABLE_STRK_ORDERS, {
    variables: { seller: myAddr, now },
    skip: !myAddr || !active,
    fetchPolicy: "network-only",
  });

  const orders: RefundableStrkOrder[] = (data?.strkorders ?? []).map(
    (o: any) => ({
      strkOrderId: o.id,
      strkAmount: o.strk_amount,
      expiry: Number(o.expiry),
    }),
  );

  const [hidden, setHidden] = useState<Set<string>>(new Set());
  const remove = (id: string) => setHidden((prev) => new Set([...prev, id]));
  const visibleOrders = orders.filter((o) => !hidden.has(o.strkOrderId));

  return { orders: visibleOrders, scanning, scan: refetch, remove };
}

// ── Presentational components ─────────────────────────────────────────────────

function OrderListSection({
  title,
  scanning,
  onRefresh,
  connected,
  emptyText,
  children,
}: {
  title: string;
  scanning: boolean;
  onRefresh: () => void;
  connected: boolean;
  emptyText: string;
  children: React.ReactNode;
}) {
  const count = React.Children.count(children);
  return (
    <div style={styles.section}>
      <div
        style={{
          display: "flex",
          justifyContent: "space-between",
          alignItems: "center",
        }}
      >
        <div style={styles.sectionLabel}>{title}</div>
        <button
          onClick={onRefresh}
          disabled={scanning}
          style={{
            ...btnGhost,
            width: "auto",
            padding: "0.3rem 0.65rem",
            fontSize: "0.62rem",
          }}
        >
          {scanning ? (
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

      {!connected && (
        <div style={styles.emptyState}>Connect wallet to see your orders</div>
      )}

      {connected && scanning && (
        <div
          style={{
            display: "flex",
            alignItems: "center",
            gap: "0.5rem",
            color: "#3a3a4a",
            fontSize: "0.68rem",
            padding: "0.25rem 0",
          }}
        >
          <FaSpinner
            size={11}
            style={{ animation: "spin 1s linear infinite" }}
          />{" "}
          Loading from indexer…
        </div>
      )}

      {connected && !scanning && count === 0 && (
        <div style={styles.emptyState}>{emptyText}</div>
      )}

      {children}
    </div>
  );
}

function OrderCard({
  id,
  primaryValue,
  badgeLabel,
  badgeColor,
  subLabel,
  selected,
  onClick,
}: {
  id: string;
  primaryValue: string;
  badgeLabel: string;
  badgeColor: string;
  subLabel: string;
  selected: boolean;
  onClick: () => void;
}) {
  return (
    <button
      onClick={onClick}
      style={{
        background: selected ? "rgba(255,200,0,0.08)" : "#0a0a0f",
        border: `1px solid ${selected ? "rgba(255,200,0,0.4)" : "#1e1e2e"}`,
        borderRadius: 8,
        padding: "0.85rem 1rem",
        cursor: "pointer",
        textAlign: "left",
        width: "100%",
        transition: "all 0.15s",
      }}
    >
      <div
        style={{
          display: "flex",
          justifyContent: "space-between",
          alignItems: "center",
        }}
      >
        <div>
          <div
            style={{ color: "#ffc800", fontSize: "0.82rem", fontWeight: 700 }}
          >
            {primaryValue}
          </div>
          <div
            style={{
              color: "#3a3a4a",
              fontSize: "0.6rem",
              marginTop: "0.2rem",
              fontFamily: "'DM Mono', monospace",
            }}
          >
            {id.slice(0, 10)}…{id.slice(-6)}
          </div>
        </div>
        <div style={{ textAlign: "right" }}>
          <div
            style={{ color: badgeColor, fontSize: "0.62rem", fontWeight: 700 }}
          >
            {badgeLabel}
          </div>
          <div
            style={{
              color: selected ? "#ffc800" : "#2a2a3a",
              fontSize: "0.58rem",
              marginTop: "0.15rem",
            }}
          >
            {subLabel}
          </div>
        </div>
      </div>
    </button>
  );
}

function OrderLookup({
  mode,
  orderId,
  onOrderIdChange,
  onLookup,
  loading,
  orderStatus,
  statusMsg,
}: {
  mode: ActionMode;
  orderId: string;
  onOrderIdChange: (v: string) => void;
  onLookup: () => void;
  loading: boolean;
  orderStatus: OrderStatus | null;
  statusMsg: { text: string; color: string } | null;
}) {
  return (
    <div style={styles.section}>
      <div style={styles.sectionLabel}>
        {mode.includes("strk") ? "STRK order ID" : "wBTC order ID"}
      </div>
      <div style={{ display: "flex", gap: "0.5rem" }}>
        <input
          value={orderId}
          onChange={(e) => onOrderIdChange(e.target.value)}
          placeholder="0x…"
          style={{ ...inputStyle, flex: 1 }}
        />
        <button
          onClick={onLookup}
          disabled={loading || !orderId.trim()}
          style={{
            ...btnPrimary(!!(orderId.trim() && !loading)),
            width: "auto",
            padding: "0.6rem 1rem",
            flexShrink: 0,
          }}
        >
          {loading ? (
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
  );
}

function SecretInput({
  secret,
  onSecretChange,
  onFileLoad,
}: {
  secret: string;
  onSecretChange: (v: string) => void;
  onFileLoad: (f: File) => void;
}) {
  return (
    <div style={styles.section}>
      <div style={styles.sectionLabel}>Your swap secret</div>
      <input
        value={secret}
        onChange={(e) => onSecretChange(e.target.value)}
        placeholder="0x… (your secret from umbra-swap-secret.json)"
        style={inputStyle}
      />
      <label
        htmlFor="secret-file"
        style={styles.uploadLabel}
        onMouseEnter={(e) => (e.currentTarget.style.borderColor = "#555")}
        onMouseLeave={(e) => (e.currentTarget.style.borderColor = "#1e1e2e")}
      >
        <FaUpload size={10} /> Upload umbra-swap-secret.json
        <input
          id="secret-file"
          type="file"
          accept=".json"
          style={{ display: "none" }}
          onChange={(e) => {
            const f = e.target.files?.[0];
            if (f) onFileLoad(f);
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
  );
}

function HintBox({ mode }: { mode: ActionMode }) {
  const hints: Record<ActionMode, { title: string; body: string }> = {
    withdraw_strk: {
      title: "Alice claims STRK",
      body: "Your filled orders appear above. Select one, paste your secret, and claim. This publishes the secret on-chain so Bob can then claim his wBTC.",
    },
    withdraw_wbtc: {
      title: "Bob claims wBTC",
      body: "Your ready-to-claim orders appear above — these are orders where Alice has already revealed her secret. Select one and claim. No secret input needed.",
    },
    refund_wbtc: {
      title: "Alice refunds wBTC",
      body: "Your expired unfilled orders appear above. Select one and refund. Only works if the order was never filled — if Bob locked STRK, he must refund his side first.",
    },
    refund_strk: {
      title: "Bob refunds STRK",
      body: "Your expired STRK orders appear above — these are orders where Alice never revealed the secret. Select one and reclaim your STRK.",
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

// ── Main panel ────────────────────────────────────────────────────────────────

export default function ManageOrdersPanel() {
  const { account } = useAccount();
  const { contract } = useContract({ abi, address: CONTRACT_ADDRESS });

  const [mode, setMode] = useState<ActionMode>("withdraw_strk");
  const [orderId, setOrderId] = useState("");
  const [secret, setSecret] = useState("");
  const [orderStatus, setOrderStatus] = useState<OrderStatus | null>(null);
  const [lookupLoading, setLookupLoading] = useState(false);
  const [actionLoading, setActionLoading] = useState(false);

  // Each hook receives an `active` flag so Apollo skips inactive tabs
  const claimStrk = useClaimableStrkOrders(mode === "withdraw_strk");
  const claimWbtc = useClaimableWbtcOrders(mode === "withdraw_wbtc");
  const refundWbtc = useRefundableWbtcOrders(mode === "refund_wbtc");
  const refundStrk = useRefundableStrkOrders(mode === "refund_strk");

  const lookupOrder = async (overrideId?: string) => {
    const id = overrideId ?? orderId;
    if (!contract || !id.trim()) return;
    setLookupLoading(true);
    setOrderStatus(null);
    try {
      const idU256 = uint256.bnToUint256(BigInt(id.trim()));
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
          hashlock: toHex(o.hashlock),
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
          hashlock: toHex(o.hashlock),
        });
      }
    } catch (err: any) {
      toast.error("Lookup failed: " + err?.message);
    } finally {
      setLookupLoading(false);
    }
  };

  const selectOrder = (id: string) => {
    setOrderId(id);
    lookupOrder(id);
  };

  const loadSecretFromFile = (file: File) => {
    const r = new FileReader();
    r.onload = (ev) => {
      try {
        const d = JSON.parse(ev.target?.result as string);
        if (d.swapSecret) setSecret(d.swapSecret);
      } catch {
        toast.error("Invalid secret file.");
      }
    };
    r.readAsText(file);
  };

  // ── Tx helpers ───────────────────────────────────────────────────────────────
  const exec = async (
    populate: Call,
    onSuccess: () => void,
    successMsg: string,
  ) => {
    if (!account || !contract) return;
    setActionLoading(true);
    try {
      await account.estimateInvokeFee([populate]);
      const tx = await account.execute([populate], {
        maxFee: U128_MAX,
        version: "0x3",
      } as any);
      const receipt = await account.waitForTransaction(tx.transaction_hash);
      assertReceiptSuccess(receipt);
      toast.success(successMsg);
      setOrderStatus((p) =>
        p
          ? {
              ...p,
              isWithdrawn: mode.startsWith("withdraw"),
              isRefunded: mode.startsWith("refund"),
            }
          : null,
      );
      onSuccess();
    } catch (err: any) {
      const executionError =
        err?.baseError?.data?.execution_error?.error ??
        err?.message ??
        String(err);
      toast.error(executionError);
    } finally {
      setActionLoading(false);
    }
  };

  const handleWithdrawStrk = () =>
    exec(
      contract!.populate("withdraw_strk", [
        uint256.bnToUint256(BigInt(orderId.trim())),
        secret,
      ]),
      () => claimStrk.remove(orderId),
      "STRK claimed! Your secret is now public — Bob can claim wBTC.",
    );

  const handleWithdrawWbtc = () =>
    exec(
      contract!.populate("withdraw_wbtc", [
        uint256.bnToUint256(BigInt(orderId.trim())),
      ]),
      () => claimWbtc.remove(orderId),
      "wBTC claimed! Swap complete.",
    );

  const handleRefundWbtc = () =>
    exec(
      contract!.populate("refund_wbtc", [
        uint256.bnToUint256(BigInt(orderId.trim())),
      ]),
      () => refundWbtc.remove(orderId),
      "wBTC refunded back to you.",
    );

  const handleRefundStrk = () =>
    exec(
      contract!.populate("refund_strk", [
        uint256.bnToUint256(BigInt(orderId.trim())),
      ]),
      () => refundStrk.remove(orderId),
      "STRK refunded back to you.",
    );

  // ── Derived state ────────────────────────────────────────────────────────────
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
    if (!orderStatus || orderStatus.isWithdrawn || orderStatus.isRefunded)
      return false;
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

  const statusMsg = (() => {
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
  })();

  const executeAction = () => {
    if (mode === "withdraw_strk") handleWithdrawStrk();
    else if (mode === "withdraw_wbtc") handleWithdrawWbtc();
    else if (mode === "refund_wbtc") handleRefundWbtc();
    else handleRefundStrk();
  };

  const now = Math.floor(Date.now() / 1000);

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: "1rem" }}>
      {/* Mode tabs */}
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
              setOrderId("");
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

      <HintBox mode={mode} />

      {/* Claimable STRK */}
      {mode === "withdraw_strk" && (
        <OrderListSection
          title="Your claimable STRK orders"
          scanning={claimStrk.scanning}
          onRefresh={() => claimStrk.scan()}
          connected={!!account}
          emptyText="No claimable orders found for your address"
        >
          {claimStrk.orders.map((o) => {
            const minsLeft = Math.floor((o.expiry - now) / 60);
            return (
              <OrderCard
                key={o.strkOrderId}
                id={o.strkOrderId}
                primaryValue={`${(Number(o.strkAmount) / 1e18).toLocaleString(undefined, { maximumFractionDigits: 6 })} STRK`}
                badgeLabel={
                  minsLeft < 60
                    ? `⚠ ${minsLeft}m left`
                    : `${Math.floor(minsLeft / 60)}h left`
                }
                badgeColor={minsLeft < 60 ? "#f87171" : "#555"}
                subLabel={
                  orderId === o.strkOrderId ? "✓ selected" : "click to select"
                }
                selected={orderId === o.strkOrderId}
                onClick={() => selectOrder(o.strkOrderId)}
              />
            );
          })}
        </OrderListSection>
      )}

      {/* Claimable wBTC */}
      {mode === "withdraw_wbtc" && (
        <OrderListSection
          title="Your claimable wBTC orders"
          scanning={claimWbtc.scanning}
          onRefresh={() => claimWbtc.scan()}
          connected={!!account}
          emptyText="No claimable wBTC orders — Alice may not have revealed her secret yet"
        >
          {claimWbtc.orders.map((o) => (
            <OrderCard
              key={o.wbtcOrderId}
              id={o.wbtcOrderId}
              primaryValue={`${Number(o.wbtcAmount).toLocaleString()} sat wBTC`}
              badgeLabel="✓ secret revealed"
              badgeColor="#22c55e"
              subLabel={
                now >= o.expiry
                  ? "expired"
                  : `expires ${new Date(o.expiry * 1000).toLocaleTimeString()}`
              }
              selected={orderId === o.wbtcOrderId}
              onClick={() => selectOrder(o.wbtcOrderId)}
            />
          ))}
        </OrderListSection>
      )}

      {/* Refundable wBTC */}
      {mode === "refund_wbtc" && (
        <OrderListSection
          title="Your expired wBTC orders"
          scanning={refundWbtc.scanning}
          onRefresh={() => refundWbtc.scan()}
          connected={!!account}
          emptyText="No refundable wBTC orders found"
        >
          {refundWbtc.orders.map((o) => {
            const agoMins = Math.floor((now - o.expiry) / 60);
            const agoLabel =
              agoMins < 60
                ? `${agoMins}m ago`
                : `${Math.floor(agoMins / 60)}h ago`;
            return (
              <OrderCard
                key={o.wbtcOrderId}
                id={o.wbtcOrderId}
                primaryValue={`${Number(o.wbtcAmount).toLocaleString()} sat wBTC`}
                badgeLabel="✓ eligible for refund"
                badgeColor="#22c55e"
                subLabel={`expired ${agoLabel}`}
                selected={orderId === o.wbtcOrderId}
                onClick={() => selectOrder(o.wbtcOrderId)}
              />
            );
          })}
        </OrderListSection>
      )}

      {/* Refundable STRK */}
      {mode === "refund_strk" && (
        <OrderListSection
          title="Your expired STRK orders"
          scanning={refundStrk.scanning}
          onRefresh={() => refundStrk.scan()}
          connected={!!account}
          emptyText="No refundable STRK orders found"
        >
          {refundStrk.orders.map((o) => {
            const agoMins = Math.floor((now - o.expiry) / 60);
            const agoLabel =
              agoMins < 60
                ? `${agoMins}m ago`
                : `${Math.floor(agoMins / 60)}h ago`;
            return (
              <OrderCard
                key={o.strkOrderId}
                id={o.strkOrderId}
                primaryValue={`${(Number(o.strkAmount) / 1e18).toLocaleString(undefined, { maximumFractionDigits: 6 })} STRK`}
                badgeLabel="✓ eligible for refund"
                badgeColor="#22c55e"
                subLabel={`expired ${agoLabel}`}
                selected={orderId === o.strkOrderId}
                onClick={() => selectOrder(o.strkOrderId)}
              />
            );
          })}
        </OrderListSection>
      )}

      <OrderLookup
        mode={mode}
        orderId={orderId}
        onOrderIdChange={setOrderId}
        onLookup={lookupOrder}
        loading={lookupLoading}
        orderStatus={orderStatus}
        statusMsg={statusMsg}
      />

      {mode === "withdraw_strk" && (
        <SecretInput
          secret={secret}
          onSecretChange={setSecret}
          onFileLoad={loadSecretFromFile}
        />
      )}

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
            {MODES.find((m) => m.key === mode)?.icon}{" "}
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

// ── Styles ────────────────────────────────────────────────────────────────────

const styles = {
  section: {
    background: "#111118",
    border: "1px solid #1e1e2e",
    borderRadius: 10,
    padding: "1.1rem 1.2rem",
    display: "flex",
    flexDirection: "column",
    gap: "0.65rem",
  } as React.CSSProperties,

  sectionLabel: {
    color: "#3a3a4a",
    fontSize: "0.6rem",
    letterSpacing: "0.15em",
    textTransform: "uppercase",
  } as React.CSSProperties,

  emptyState: {
    color: "#2a2a3a",
    fontSize: "0.68rem",
    textAlign: "center",
    padding: "1rem 0",
    letterSpacing: "0.06em",
  } as React.CSSProperties,

  uploadLabel: {
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
  } as React.CSSProperties,
};
