export type ExecStatus = "pending" | "claimed" | "refunded";

const CONFIG: Record<ExecStatus, { label: string; color: string; bg: string }> = {
  claimed:  { label: "BTC DELIVERED ✓", color: "var(--green)", bg: "rgba(0,255,157,0.08)" },
  pending:  { label: "PENDING",          color: "var(--amber)", bg: "rgba(255,183,3,0.08)" },
  refunded: { label: "RETRYING",         color: "var(--red)",   bg: "rgba(255,77,109,0.08)" },
};

export default function StatusBadge({ status }: { status: ExecStatus }) {
  const cfg = CONFIG[status] ?? { label: status.toUpperCase(), color: "var(--muted)", bg: "transparent" };
  return (
    <span style={{
      display: "inline-block",
      background: cfg.bg,
      color: cfg.color,
      border: `1px solid ${cfg.color}44`,
      borderRadius: 2,
      padding: "0.1rem 0.4rem",
      fontSize: "0.5rem",
      letterSpacing: "0.14em",
      fontFamily: "var(--mono)",
    }}>
      {cfg.label}
    </span>
  );
}
