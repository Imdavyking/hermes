interface SpinnerProps { size?: number }

export default function Spinner({ size = 12 }: SpinnerProps) {
  return (
    <span style={{
      display: "inline-block",
      width: size,
      height: size,
      border: "1px solid currentColor",
      borderTopColor: "transparent",
      borderRadius: "50%",
      animation: "spin 0.7s linear infinite",
      flexShrink: 0,
    }} />
  );
}
