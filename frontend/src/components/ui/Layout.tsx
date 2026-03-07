// ─── Section ──────────────────────────────────────────────────────────────────

interface SectionProps {
  title: string;
  tag?: string;
  children: React.ReactNode;
}

export function Section({ title, tag, children }: SectionProps) {
  return (
    <div style={{ border: "1px solid var(--border)", background: "var(--surface)", animation: "fadeUp 0.35s ease" }}>
      <div style={{
        display: "flex", alignItems: "center", gap: "0.75rem",
        padding: "0.6rem 1.1rem",
        borderBottom: "1px solid var(--border)",
        background: "var(--bg)",
      }}>
        <span style={{ fontFamily: "var(--display)", fontSize: "0.75rem", color: "var(--orange)", letterSpacing: "0.15em" }}>
          {title}
        </span>
        {tag && (
          <span style={{
            fontSize: "0.46rem", letterSpacing: "0.2em", color: "var(--muted)",
            border: "1px solid var(--border)", padding: "0.1rem 0.4rem",
          }}>
            {tag}
          </span>
        )}
      </div>
      <div style={{ padding: "1.1rem" }}>{children}</div>
    </div>
  );
}

// ─── Divider ──────────────────────────────────────────────────────────────────

export function Divider({ label }: { label?: string }) {
  return (
    <div style={{ display: "flex", alignItems: "center", gap: "0.6rem", margin: "0.1rem 0" }}>
      <div style={{ flex: 1, height: 1, background: "var(--border2)" }} />
      {label && (
        <span style={{ fontSize: "0.48rem", color: "var(--muted2)", letterSpacing: "0.15em", fontFamily: "var(--mono)" }}>
          {label}
        </span>
      )}
      <div style={{ flex: 1, height: 1, background: "var(--border2)" }} />
    </div>
  );
}

// ─── FieldLabel ───────────────────────────────────────────────────────────────

interface FieldLabelProps {
  children: React.ReactNode;
  hint?: string;
}

export function FieldLabel({ children, hint }: FieldLabelProps) {
  return (
    <div style={{
      display: "flex", justifyContent: "space-between", alignItems: "baseline",
      marginBottom: "0.42rem",
    }}>
      <span style={{ fontSize: "0.52rem", letterSpacing: "0.2em", color: "var(--muted)", textTransform: "uppercase" }}>
        {children}
      </span>
      {hint && <span style={{ fontSize: "0.58rem", color: "var(--muted2)" }}>{hint}</span>}
    </div>
  );
}

// ─── SummaryRow ───────────────────────────────────────────────────────────────

interface SummaryRowProps {
  label: string;
  value: string;
  accent?: boolean;
  warn?: boolean;
}

export function SummaryRow({ label, value, accent, warn }: SummaryRowProps) {
  return (
    <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
      <span style={{ fontSize: "0.6rem", color: "var(--muted)", letterSpacing: "0.06em" }}>{label}</span>
      <span style={{
        fontSize: "0.68rem",
        color: warn ? "var(--red)" : accent ? "var(--orange)" : "var(--text2)",
        fontWeight: accent ? 700 : 400,
        fontFamily: "var(--mono)",
      }}>
        {value}
      </span>
    </div>
  );
}

// ─── StatCell ─────────────────────────────────────────────────────────────────

interface StatCellProps {
  label: string;
  value: string;
  accent?: boolean;
  large?: boolean;
}

export function StatCell({ label, value, accent, large }: StatCellProps) {
  return (
    <div style={{ background: "var(--surface)", padding: "0.85rem 1.1rem", display: "flex", flexDirection: "column", gap: "0.25rem" }}>
      <div style={{ fontSize: "0.48rem", color: "var(--muted)", letterSpacing: "0.2em", textTransform: "uppercase" }}>
        {label}
      </div>
      <div style={{
        fontFamily: large ? "var(--display)" : "var(--mono)",
        fontSize: large ? "1.35rem" : "0.82rem",
        color: accent ? "var(--orange)" : "var(--text)",
        letterSpacing: large ? "0.04em" : "0.06em",
        lineHeight: 1.1,
        animation: "number-flip 0.4s ease",
      }}>
        {value}
      </div>
    </div>
  );
}
