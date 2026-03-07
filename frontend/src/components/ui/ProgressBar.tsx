interface ProgressBarProps { value: number; max: number }

export default function ProgressBar({ value, max }: ProgressBarProps) {
  const pct = Math.min(100, (value / max) * 100);
  return (
    <div style={{ height: 2, background: "var(--border2)", borderRadius: 1, overflow: "hidden" }}>
      <div style={{
        height: "100%",
        width: `${pct}%`,
        background: "var(--orange)",
        boxShadow: "0 0 6px rgba(247,147,26,0.5)",
        transition: "width 0.8s cubic-bezier(0.4,0,0.2,1)",
      }} />
    </div>
  );
}
