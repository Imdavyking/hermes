interface ChipGroupProps {
  options: (number | string)[];
  value: number | string;
  onChange: (v: any) => void;
  suffix?: string;
}

export default function ChipGroup({ options, value, onChange, suffix = "" }: ChipGroupProps) {
  return (
    <div style={{ display: "flex", gap: "0.35rem", flexWrap: "wrap" }}>
      {options.map((opt) => {
        const active = value === opt;
        return (
          <button
            key={opt}
            onClick={() => onChange(opt)}
            style={{
              background: active ? "var(--orange)" : "transparent",
              color: active ? "#000" : "var(--muted)",
              border: `1px solid ${active ? "var(--orange)" : "var(--border)"}`,
              padding: "0.32rem 0.7rem",
              fontSize: "0.7rem",
              fontFamily: "var(--mono)",
              fontWeight: active ? 700 : 400,
              letterSpacing: "0.06em",
              borderRadius: 3,
              cursor: "pointer",
              transition: "all 0.12s",
            }}
          >
            {opt}{suffix}
          </button>
        );
      })}
    </div>
  );
}
