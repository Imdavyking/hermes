import { useState } from "react";
import { toast } from "react-toastify";
import { useAccount, useContract } from "@starknet-react/core";
import { uint256 } from "starknet";
import { useQuery } from "@apollo/client";
import abi from "../../assets/json/abi";
import { CONTRACT_ADDRESS } from "../../utils/constants";
import { assertReceiptSuccess } from "../../utils/helpers";
import {
  GET_ACTIVE_DCA_ORDERS,
  GET_DCA_EXECUTIONS,
} from "../../graphql/queries";
import OrderCard, { type DcaOrder, type DcaExecution } from "./OrderCard";
import Spinner from "../ui/Spinner";

const toHexAddr = (raw: string) =>
  "0x" + BigInt(raw).toString(16).padStart(64, "0");

interface OrdersPanelProps {
  keeperFee: bigint;
  btcUsd: number | null;
}

export default function OrdersPanel({ keeperFee, btcUsd }: OrdersPanelProps) {
  const { address, account } = useAccount();
  const { contract } = useContract({ abi, address: CONTRACT_ADDRESS });

  const myAddr = address ? toHexAddr(address) : "";
  const [expanded, setExpanded] = useState<string | null>(null);
  const [cancelling, setCancelling] = useState<string | null>(null);
  const [hidden, setHidden] = useState<Set<string>>(new Set());

  const {
    data: ordersData,
    loading: ordersLoading,
    refetch,
  } = useQuery(GET_ACTIVE_DCA_ORDERS, {
    variables: { owner: myAddr },
    skip: !myAddr,
    fetchPolicy: "network-only",
  });

  const orders: DcaOrder[] = ((ordersData?.dcaorders ?? []) as any[])
    .filter((o: any) => !hidden.has(o.id))
    .map((o: any) => ({
      orderId: o.id,
      owner: o.owner,
      usdcPerInterval: o.usdc_per_interval,
      intervalSeconds: Number(o.interval_seconds),
      totalIntervals: Number(o.total_intervals),
      executedIntervals: Number(o.executed_intervals),
      isActive: Boolean(o.is_active),
      lastExecution: Number(o.last_execution),
      btcDestination: o.btc_destination ?? "",
      totalUsdcDeposited: o.total_usdc_deposited,
      createdTxHash: o.created_tx_hash,
    }));

  const { data: execData, loading: execLoading } = useQuery(
    GET_DCA_EXECUTIONS,
    {
      variables: { orderId: expanded ?? "" },
      skip: !expanded,
      fetchPolicy: "network-only",
    },
  );

  const execHistory: DcaExecution[] = (
    (execData?.dcaexecutions ?? []) as any[]
  ).map((e: any) => ({
    executedIntervals: Number(e.executed_intervals),
    usdcSpent: e.usdc_spent,
    keeper: e.keeper,
    status: e.status ?? "pending",
    executedTimestamp: Number(e.executed_timestamp),
    executedTxHash: e.executed_tx_hash,
    claimedAtBlock: e.claimed_at_block ? Number(e.claimed_at_block) : null,
    refundedAtBlock: e.refunded_at_block ? Number(e.refunded_at_block) : null,
  }));

  const handleCancel = async (orderId: string) => {
    if (!account || !contract) return;
    setCancelling(orderId);
    const toastId = toast.loading("Cancelling order…");
    try {
      const populate = contract.populate("cancel_dca", [
        uint256.bnToUint256(BigInt(orderId)),
      ]);
      await account.estimateInvokeFee([populate]);
      const tx = await account.execute([populate]);
      const receipt = await account.waitForTransaction(tx.transaction_hash);
      assertReceiptSuccess(receipt);
      toast.update(toastId, {
        render: "Order cancelled. Unspent USDC + STRK fee reserve refunded.",
        isLoading: false,
        type: "success",
        autoClose: 5000,
      });
      setHidden((p) => new Set([...p, orderId]));
      if (expanded === orderId) setExpanded(null);
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

  if (!address) {
    return (
      <div
        style={{
          textAlign: "center",
          padding: "2rem",
          fontSize: "0.65rem",
          color: "var(--muted2)",
          letterSpacing: "0.12em",
          fontFamily: "var(--mono)",
        }}
      >
        CONNECT WALLET TO SEE YOUR ORDERS
      </div>
    );
  }

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: "0.6rem" }}>
      {/* Toolbar */}
      <div
        style={{
          display: "flex",
          justifyContent: "space-between",
          alignItems: "center",
          marginBottom: "0.25rem",
        }}
      >
        <span
          style={{
            fontSize: "0.55rem",
            color: "var(--muted)",
            letterSpacing: "0.15em",
          }}
        >
          {ordersLoading
            ? "LOADING…"
            : `${orders.length} ACTIVE ORDER${orders.length !== 1 ? "S" : ""}`}
        </span>
        <button
          onClick={() => refetch()}
          style={{
            background: "transparent",
            color: "var(--muted)",
            border: "1px solid var(--border2)",
            padding: "0.25rem 0.65rem",
            fontSize: "0.55rem",
            letterSpacing: "0.12em",
            fontFamily: "var(--mono)",
            borderRadius: 2,
            cursor: "pointer",
            display: "flex",
            alignItems: "center",
            gap: "0.35rem",
          }}
        >
          {ordersLoading ? <Spinner size={9} /> : "↻"} REFRESH
        </button>
      </div>

      {ordersLoading && (
        <div
          style={{
            display: "flex",
            alignItems: "center",
            gap: "0.5rem",
            fontSize: "0.62rem",
            color: "var(--muted)",
          }}
        >
          <Spinner size={10} /> Loading from indexer…
        </div>
      )}

      {!ordersLoading && orders.length === 0 && (
        <div
          style={{
            textAlign: "center",
            padding: "2rem",
            fontSize: "0.62rem",
            color: "var(--muted2)",
            letterSpacing: "0.12em",
          }}
        >
          NO ACTIVE DCA ORDERS
        </div>
      )}

      {orders.map((order) => (
        <OrderCard
          key={order.orderId}
          order={order}
          keeperFee={keeperFee}
          btcUsd={btcUsd}
          expanded={expanded === order.orderId}
          onToggle={() =>
            setExpanded(expanded === order.orderId ? null : order.orderId)
          }
          onCancel={handleCancel}
          cancelling={cancelling === order.orderId}
          execHistory={expanded === order.orderId ? execHistory : []}
          execLoading={expanded === order.orderId && execLoading}
        />
      ))}
    </div>
  );
}
