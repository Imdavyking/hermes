import Spinner from "./Spinner";

interface BtnProps {
  children: React.ReactNode;
  onClick?: () => void;
  disabled?: boolean;
  loading?: boolean;
  fullWidth?: boolean;
  type?: "button" | "submit";
}

export function BtnPrimary({ children, onClick, disabled, loading, fullWidth = true }: BtnProps) {
  return (
    <button
      onClick={onClick}
      disabled={disabled || loading}
      type="button"
      style={{
        background: disabled || loading ? "transparent" : "var(--orange)",
        color: disabled || loading ? "var(--muted)" : "#000",
        border: `1px solid ${disabled || loading ? "var(--border)" : "var(--orange)"}`,
        padding: "0.7rem 1.1rem",
        fontSize: "0.7rem",
        fontWeight: 700,
        letterSpacing: "0.1em",
        textTransform: "uppercase" as const,
        fontFamily: "var(--mono)",
        borderRadius: 3,
        width: fullWidth ? "100%" : "auto",
        display: "inline-flex",
        alignItems: "center",
        justifyContent: "center",
        gap: "0.5rem",
        transition: "all 0.15s",
        animation: !disabled && !loading ? "glow-pulse 3s ease infinite" : "none",
        cursor: disabled || loading ? "not-allowed" : "pointer",
      }}
    >
      {loading ? <><Spinner /> Loading…</> : children}
    </button>
  );
}

export function BtnGhost({ children, onClick, disabled, loading, fullWidth = true }: BtnProps) {
  return (
    <button
      onClick={onClick}
      disabled={disabled || loading}
      type="button"
      style={{
        background: "transparent",
        color: disabled || loading ? "var(--muted2)" : "var(--text2)",
        border: `1px solid ${disabled || loading ? "var(--border2)" : "var(--border)"}`,
        padding: "0.68rem 1rem",
        fontSize: "0.68rem",
        letterSpacing: "0.08em",
        fontFamily: "var(--mono)",
        borderRadius: 3,
        width: fullWidth ? "100%" : "auto",
        display: "inline-flex",
        alignItems: "center",
        justifyContent: "center",
        gap: "0.5rem",
        transition: "all 0.15s",
        cursor: disabled || loading ? "not-allowed" : "pointer",
      }}
    >
      {loading ? <><Spinner /> Loading…</> : children}
    </button>
  );
}

export function BtnDanger({ children, onClick, disabled, loading, fullWidth = true }: BtnProps) {
  return (
    <button
      onClick={onClick}
      disabled={disabled || loading}
      type="button"
      style={{
        background: "transparent",
        color: disabled || loading ? "var(--muted2)" : "var(--red)",
        border: `1px solid ${disabled || loading ? "var(--border2)" : "rgba(255,77,109,0.3)"}`,
        padding: "0.65rem",
        fontSize: "0.62rem",
        letterSpacing: "0.1em",
        textTransform: "uppercase" as const,
        fontFamily: "var(--mono)",
        borderRadius: 3,
        width: fullWidth ? "100%" : "auto",
        display: "inline-flex",
        alignItems: "center",
        justifyContent: "center",
        gap: "0.5rem",
        transition: "all 0.15s",
        cursor: disabled || loading ? "not-allowed" : "pointer",
      }}
    >
      {loading ? <><Spinner /> Loading…</> : children}
    </button>
  );
}
