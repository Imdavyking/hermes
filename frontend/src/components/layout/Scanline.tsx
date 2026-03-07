export default function Scanline() {
  return (
    <div style={{
      position: "fixed", inset: 0, zIndex: 0, pointerEvents: "none",
      background: "repeating-linear-gradient(0deg, transparent, transparent 2px, rgba(0,0,0,0.025) 2px, rgba(0,0,0,0.025) 4px)",
    }}>
      <div style={{
        position: "absolute", left: 0, right: 0, height: "25vh",
        background: "linear-gradient(to bottom, transparent, rgba(247,147,26,0.012), transparent)",
        animation: "scanline 9s linear infinite",
      }} />
    </div>
  );
}
