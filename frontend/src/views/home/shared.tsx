import React from "react";

// ─── Types ────────────────────────────────────────────────────────────────────

export type Tab = "deposit" | "withdraw";
export type DepositStep = 1 | 2 | 3 | 4;

export type CommitmentData = {
  nullifier: `0x${string}`;
  secret: `0x${string}`;
  commitment: `0x${string}`;
};

// ─── Helpers ──────────────────────────────────────────────────────────────────

export function shortenAddress(addr: string) {
  if (!addr || addr.length < 10) return addr;
  const hex = addr.toString().startsWith("0x")
    ? addr
    : "0x" + BigInt(addr).toString(16);
  return `${hex.slice(0, 6)}…${hex.slice(-4)}`;
}

export function formatRate8(raw: bigint): string {
  const whole = raw / 10n ** 8n;
  const frac = (raw % 10n ** 8n).toString().padStart(8, "0").slice(0, 2);
  return `${whole.toLocaleString()}.${frac}`;
}

export function hexRoot(val: any): string {
  try {
    return "0x" + BigInt(val.toString()).toString(16).slice(0, 12) + "…";
  } catch {
    return "—";
  }
}

// ─── Shared Styles ────────────────────────────────────────────────────────────

export const inputStyle: React.CSSProperties = {
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

export const btnPrimary = (enabled: boolean): React.CSSProperties => ({
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

export const btnGhost: React.CSSProperties = {
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

// ─── Sub-components ───────────────────────────────────────────────────────────

export function StatCard({
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

export function StepRow({
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
    <div style={{ display: "flex", alignItems: "center", gap: "0.7rem" }}>
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

export function NotePreview({
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
