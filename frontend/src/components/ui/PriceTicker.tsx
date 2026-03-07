interface PriceTickerProps {
  btcPrice: number;
  strkPrice: number;
}

const STATIC_ITEMS = [
  "NETWORK  STARKNET SEPOLIA",
  "ORACLE  CHAINLINK → PRAGMA FALLBACK",
  "DELIVERY  NATIVE BTC VIA ATOMIQ",
  "KEEPER FEE  0.5 STRK / INTERVAL",
  "MAX INTERVAL  720H",
  "MAX EXECUTIONS  1,000",
];

export default function PriceTicker({ btcPrice, strkPrice }: PriceTickerProps) {
  const priceItems = [
    `BTC/USD  $${btcPrice ? (btcPrice / 1e8).toLocaleString(undefined, { maximumFractionDigits: 0 }) : "—"}`,
    `STRK/USD  $${strkPrice ? (strkPrice / 1e8).toFixed(4) : "—"}`,
  ];

  const items = [...priceItems, ...STATIC_ITEMS];
  const doubled = [...items, ...items];

  return (
    <div style={{
      borderBottom: "1px solid var(--border)",
      overflow: "hidden",
      background: "var(--surface)",
      position: "relative",
      zIndex: 10,
    }}>
      <div style={{
        display: "flex",
        whiteSpace: "nowrap",
        animation: "ticker 32s linear infinite",
        width: "max-content",
      }}>
        {doubled.map((item, i) => {
          const isPrice = i % items.length < 2;
          return (
            <span key={i} style={{
              display: "inline-flex",
              alignItems: "center",
              padding: "0.42rem 2rem",
              fontSize: "0.6rem",
              letterSpacing: "0.12em",
              color: isPrice ? "var(--orange)" : "var(--muted)",
              borderRight: "1px solid var(--border2)",
            }}>
              {isPrice && (
                <span style={{ color: "var(--green)", marginRight: "0.35rem", fontSize: "0.48rem" }}>▲</span>
              )}
              {item}
            </span>
          );
        })}
      </div>
    </div>
  );
}
