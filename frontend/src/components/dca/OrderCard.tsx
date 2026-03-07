import { useState, useEffect } from "react";
import StatusBadge, { type ExecStatus } from "../ui/Badge";
import ProgressBar from "../ui/ProgressBar";
import { Divider, FieldLabel, SummaryRow } from "../ui/Layout";
import { BtnDanger } from "../ui/Button";
import Spinner from "../ui/Spinner";

export interface DcaOrder {
  orderId: string;
  owner: string;
  usdcPerInterval: string;
  intervalSeconds: number;
  totalIntervals: number;
  executedIntervals: number;
  isActive: boolean;
  lastExecution: number;
  btcDestination: string;
  totalUsdcDeposited: string;
  createdTxHash: string;
}

export interface DcaExecution {
  executedIntervals: number;
  usdcSpent: string;
  keeper: string;
  status: ExecStatus;
  executedTimestamp: number;
  executedTxHash: string;
  claimedAtBlock: number | null;
  refundedAtBlock: number | null;
}

const fmtUsdc = (raw: string | number) =>
  "$" + (Number(raw) / 1e6).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 });

const fmtStrk = (raw: bigint | number) =>
  (Number(raw) / 1e18).toLocaleString(undefined, { maximumFractionDigits: 4 }) + " STRK";

const fmtInterval = (secs: number) => {
  if (secs < 3600) return `${secs / 60}m`;
  if (secs < 86400) return `${secs / 3600}h`;
  return `${Math.round(secs / 86400)}d`;
};

const fmtCountdown = (nextTs: number, now: number) => {
  const d = nextTs - now;
  if (d <= 0) return "READY";
  if (d < 3600) return `${Math.floor(d / 60)}m ${d % 60}s`;
  if (d < 86400) return `${Math.floor(d / 3600)}h ${Math.floor((d % 3600) / 60)}m`;
  return `${Math.floor(d / 86400)}d ${Math.floor((d % 86400) / 3600)}h`;
};

const fmtDate = (ts: number) =>
  new Date(ts * 1000).toLocaleDateString(undefined, {
    month: "short", day: "numeric", hour: "2-digit", minute: "2-digit",
  });

const shortenAddr = (a: string) => a?.slice(0, 8) + "…" + a?.slice(-6);

interface OrderCardProps {
  order: DcaOrder;
  keeperFee: bigint;
  btcUsd: number | null;
  expanded: boolean;
  onToggle: () => void;
  onCancel: (id: string) => void;
  cancelling: boolean;
  execHistory: DcaExecution[];
  execLoading: boolean;
}

export default function OrderCard({
  order, keeperFee, btcUsd,
  expanded, onToggle, onCancel, cancelling,
  execHistory, execLoading,
}: OrderCardProps) {
  const [, setTick] = useState(0);

  useEffect(() => {
    if (!expanded) return;
    const t = setInterval(() => setTick((n) => n + 1), 1000);
    return () => clearInterval(t);
  }, [expanded]);

  const nowLive = Math.floor(Date.now() / 1000);
  const nextDueTs = order.lastExecution + order.intervalSeconds;
  const isReady = nextDueTs <= nowLive;
  const remaining = order.totalIntervals - order.executedIntervals;
  const strkRefund = keeperFee * BigInt(remaining);
  const confirmedExecs = execHistory.filter((e) => e.status === "claimed");
  const totalSpent = confirmedExecs.reduce((a, e) => a + Number(e.usdcSpent), 0);

  return (
    <div style={{
      border: `1px solid ${expanded ? "rgba(247,147,26,0.35)" : "var(--border)"}`,
      borderRadius: 3,
      overflow: "hidden",
      transition: "border-color 0.2s",
      animation: "fadeIn 0.25s ease",
    }}>
      {/* Header row */}
      <div
        onClick={onToggle}
        style={{
          background: expanded ? "rgba(247,147,26,0.03)" : "var(--bg)",
          padding: "0.85rem 1rem",
          display: "flex", alignItems: "center", gap: "1rem",
          cursor: "pointer",
          userSelect: "none",
        }}
      >
        <span style={{ fontSize: "1.1rem", lineHeight: 1, color: "var(--orange)" }}>₿</span>

        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ display: "flex", alignItems: "baseline", gap: "0.45rem", marginBottom: "0.3rem" }}>
            <span style={{ fontSize: "0.85rem", color: "var(--text)", fontWeight: 700, fontFamily: "var(--mono)" }}>
              {fmtUsdc(order.usdcPerInterval)}
            </span>
            <span style={{ fontSize: "0.58rem", color: "var(--muted)", fontFamily: "var(--mono)" }}>
              / {fmtInterval(order.intervalSeconds)}
            </span>
          </div>
          <ProgressBar value={order.executedIntervals} max={order.totalIntervals} />
          <div style={{ display: "flex", gap: "1rem", marginTop: "0.28rem" }}>
            <span style={{ fontSize: "0.52rem", color: "var(--muted)", letterSpacing: "0.08em" }}>
              {order.executedIntervals}/{order.totalIntervals} DONE
            </span>
            <span style={{ fontSize: "0.52rem", color: "var(--muted)", letterSpacing: "0.08em" }}>
              {Math.round((order.executedIntervals / order.totalIntervals) * 100)}% COMPLETE
            </span>
          </div>
        </div>

        {/* Countdown */}
        <div style={{ display: "flex", flexDirection: "column", alignItems: "flex-end", gap: "0.15rem", minWidth: 90 }}>
          <span style={{ fontSize: "0.46rem", color: "var(--muted)", letterSpacing: "0.15em" }}>NEXT IN</span>
          <span style={{
            fontFamily: "var(--display)", fontSize: "1rem",
            color: isReady ? "var(--green)" : "var(--orange)",
            letterSpacing: "0.06em",
          }}>
            {fmtCountdown(nextDueTs, nowLive)}
          </span>
        </div>

        <span style={{
          fontSize: "0.55rem", color: "var(--muted)",
          transform: expanded ? "rotate(180deg)" : "none",
          transition: "transform 0.2s", display: "inline-block",
        }}>▼</span>
      </div>

      {/* Expanded panel */}
      {expanded && (
        <div style={{
          borderTop: "1px solid var(--border)",
          padding: "1rem",
          display: "flex", flexDirection: "column", gap: "0.85rem",
          animation: "fadeUp 0.2s ease",
        }}>
          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: "0.35rem 1.5rem" }}>
            <SummaryRow label="Order ID" value={`#${order.orderId}`} />
            <SummaryRow label="Interval" value={fmtInterval(order.intervalSeconds)} />
            <SummaryRow label="Remaining" value={`${remaining} / ${order.totalIntervals}`} />
            <SummaryRow label="Total deposited" value={fmtUsdc(order.totalUsdcDeposited)} />
            <SummaryRow label="STRK reserve left" value={fmtStrk(strkRefund)} />
            {btcUsd && (
              <SummaryRow
                label="Est. BTC / exec"
                value={Math.floor((Number(order.usdcPerInterval) / 1e6 / btcUsd) * 1e8).toLocaleString() + " sat"}
              />
            )}
          </div>

          {order.btcDestination && (
            <div>
              <FieldLabel>BTC destination</FieldLabel>
              <div style={{
                background: "var(--bg)", border: "1px solid var(--border2)",
                padding: "0.5rem 0.75rem", fontSize: "0.62rem",
                color: "var(--text2)", borderRadius: 3,
                wordBreak: "break-all", letterSpacing: "0.04em", fontFamily: "var(--mono)",
              }}>
                {order.btcDestination}
              </div>
            </div>
          )}

          <Divider label="EXECUTION HISTORY" />

          {execLoading && (
            <div style={{ display: "flex", alignItems: "center", gap: "0.5rem", fontSize: "0.62rem", color: "var(--muted)" }}>
              <Spinner size={10} /> Loading from indexer…
            </div>
          )}

          {!execLoading && execHistory.length === 0 && (
            <div style={{ fontSize: "0.62rem", color: "var(--muted2)", textAlign: "center", padding: "0.5rem 0", letterSpacing: "0.1em" }}>
              NO EXECUTIONS YET
            </div>
          )}

          {execHistory.map((e) => (
            <div key={e.executedIntervals} style={{
              background: "var(--bg)",
              border: `1px solid ${e.status === "claimed" ? "rgba(0,255,157,0.12)" : e.status === "refunded" ? "rgba(255,77,109,0.12)" : "var(--border2)"}`,
              padding: "0.6rem 0.85rem", borderRadius: 3,
              display: "flex", justifyContent: "space-between", alignItems: "center", gap: "0.75rem",
              animation: "fadeIn 0.2s ease",
            }}>
              <div>
                <div style={{ display: "flex", alignItems: "center", gap: "0.5rem", marginBottom: "0.22rem" }}>
                  <span style={{ fontSize: "0.65rem", color: "var(--text2)", fontWeight: 700 }}>#{e.executedIntervals}</span>
                  <StatusBadge status={e.status} />
                </div>
                <div style={{ fontSize: "0.56rem", color: "var(--muted)" }}>
                  {fmtUsdc(e.usdcSpent)} · keeper {shortenAddr(e.keeper)}
                </div>
                {e.status === "refunded" && (
                  <div style={{ fontSize: "0.53rem", color: "var(--red)", marginTop: "0.2rem" }}>
                    LP failed — interval will be retried automatically
                  </div>
                )}
              </div>
              <div style={{ fontSize: "0.56rem", color: "var(--muted2)", textAlign: "right", flexShrink: 0 }}>
                {e.executedTimestamp ? fmtDate(e.executedTimestamp) : "—"}
              </div>
            </div>
          ))}

          {confirmedExecs.length > 1 && (
            <div style={{
              background: "rgba(247,147,26,0.04)",
              border: "1px solid rgba(247,147,26,0.12)",
              padding: "0.6rem 0.85rem", borderRadius: 3,
              fontSize: "0.62rem",
            }}>
              <span style={{ color: "var(--muted)" }}>{confirmedExecs.length} confirmed deliveries · total spent </span>
              <span style={{ color: "var(--orange)", fontWeight: 700 }}>{fmtUsdc(totalSpent.toFixed(0))}</span>
            </div>
          )}

          <Divider />

          <BtnDanger
            onClick={() => onCancel(order.orderId)}
            loading={cancelling}
          >
            {!cancelling && `✕ Cancel & refund ${fmtUsdc(String(Number(order.usdcPerInterval) * remaining))} USDC + ${fmtStrk(strkRefund)}`}
          </BtnDanger>
        </div>
      )}
    </div>
  );
}
