import { useNavigate } from "react-router-dom";
import { useReadContract } from "@starknet-react/core";
import abi from "../assets/json/abi";
import { CONTRACT_ADDRESS } from "../utils/constants";
import Scanline from "../components/layout/Scanline";
import Header from "../components/layout/Header";
import PriceTicker from "../components/layout/PriceTicker";
import { useAccount } from "@starknet-react/core";

const STEPS = [
  {
    n: "01",
    title: "SET YOUR SCHEDULE",
    body: "Choose how much USDC to spend per interval, how often, and how many times. Deposit USDC + a small STRK keeper fee upfront — no recurring approvals needed.",
  },
  {
    n: "02",
    title: "KEEPER EXECUTES",
    body: "A keeper monitors your order via checker(). When the interval elapses, it commits STRK to an Atomiq escrow — the cross-chain LP network that routes your BTC.",
  },
  {
    n: "03",
    title: "BTC ARRIVES",
    body: "Native Bitcoin lands in your Bitcoin wallet each interval. Not a wrapped token — real BTC on the Bitcoin network, delivered by Atomiq's LP network.",
  },
];

const FEATURES = [
  { label: "Native BTC delivery", sub: "Real Bitcoin to your wallet" },
  { label: "Chainlink + Pragma", sub: "Dual-oracle price feeds" },
  { label: "Keeper automation", sub: "Zero manual execution" },
  { label: "Cancel anytime", sub: "Full USDC + fee refund" },
  { label: "5% tolerance guard", sub: "Protects against manipulation" },
  { label: "Non-custodial", sub: "Your keys, your Bitcoin" },
];

export default function HomePage() {
  const navigate = useNavigate();
  const { address } = useAccount();

  const { data: btcPriceData } = useReadContract({
    abi,
    address: CONTRACT_ADDRESS,
    functionName: "get_btc_usd_price",
    args: [],
    watch: true,
    refetchInterval: 30_000,
  });

  const { data: strkPriceData } = useReadContract({
    abi,
    address: CONTRACT_ADDRESS,
    functionName: "get_strk_usd_price",
    args: [],
    watch: true,
    refetchInterval: 30_000,
  });

  const btcPrice = btcPriceData ? Number((btcPriceData as any)[0]) : 0;
  const strkPrice = strkPriceData ? Number((strkPriceData as any)[0]) : 0;
  const btcFormatted = btcPrice
    ? `$${(btcPrice / 1e8).toLocaleString(undefined, { maximumFractionDigits: 0 })}`
    : "—";

  return (
    <>
      <Scanline />
      <div
        style={{
          position: "relative",
          zIndex: 1,
          minHeight: "100vh",
          fontFamily: "var(--mono)",
        }}
      >
        <Header btcPrice={btcPrice} />
        <PriceTicker btcPrice={btcPrice} strkPrice={strkPrice} />

        {/* ── Hero ──────────────────────────────────────────────────────── */}
        <section
          style={{
            maxWidth: 900,
            margin: "0 auto",
            padding: "5rem 1.5rem 4rem",
            display: "grid",
            gridTemplateColumns: "1fr 1fr",
            gap: "3rem",
            alignItems: "center",
          }}
        >
          {/* Left: headline + CTA */}
          <div style={{ animation: "hero-reveal 0.6s ease both" }}>
            {/* Track badge */}
            <div
              style={{
                display: "inline-flex",
                alignItems: "center",
                gap: "0.5rem",
                border: "1px solid rgba(247,147,26,0.3)",
                padding: "0.25rem 0.75rem",
                marginBottom: "1.75rem",
                background: "rgba(247,147,26,0.04)",
              }}
            >
              <span
                style={{
                  width: 5,
                  height: 5,
                  borderRadius: "50%",
                  background: "var(--orange)",
                  display: "block",
                }}
              />
              <span
                style={{
                  fontSize: "0.52rem",
                  color: "var(--orange)",
                  letterSpacing: "0.2em",
                }}
              >
                BITCOIN TRACK · BTC DCA TOOL · STARKNET
              </span>
            </div>

            {/* Big headline */}
            <h1
              style={{
                fontFamily: "var(--display)",
                fontSize: "clamp(3.2rem, 8vw, 5.5rem)",
                lineHeight: 0.95,
                letterSpacing: "0.02em",
                color: "var(--text)",
                marginBottom: "0.1em",
              }}
            >
              STACK
              <br />
              <span style={{ color: "var(--orange)" }}>SATS</span>
              <br />
              ON A
              <br />
              SCHEDULE
            </h1>

            <p
              style={{
                fontSize: "0.75rem",
                color: "var(--muted)",
                lineHeight: 1.8,
                marginTop: "1.5rem",
                marginBottom: "2rem",
                maxWidth: 380,
                letterSpacing: "0.04em",
              }}
            >
              Automated USDC → native Bitcoin purchases delivered directly to
              your Bitcoin wallet. No bridging. No wrapping. Real BTC.
            </p>

            {/* CTA */}
            <div
              style={{ display: "flex", gap: "0.75rem", alignItems: "center" }}
            >
              <button
                onClick={() => navigate("/app")}
                style={{
                  background: "var(--orange)",
                  color: "#000",
                  border: "1px solid var(--orange)",
                  padding: "0.85rem 2rem",
                  fontSize: "0.75rem",
                  fontWeight: 700,
                  letterSpacing: "0.12em",
                  textTransform: "uppercase",
                  fontFamily: "var(--mono)",
                  borderRadius: 3,
                  cursor: "pointer",
                  animation: "glow-pulse 3s ease infinite",
                  transition: "all 0.15s",
                }}
              >
                Start DCA →
              </button>
              <span
                style={{
                  fontSize: "0.58rem",
                  color: "var(--muted2)",
                  letterSpacing: "0.08em",
                }}
              >
                Starknet Sepolia
              </span>
            </div>
          </div>

          {/* Right: live BTC price card */}
          <div
            style={{
              animation: "hero-reveal 0.6s 0.15s ease both",
              opacity: 0,
            }}
          >
            <div
              style={{
                border: "1px solid var(--border)",
                background: "var(--surface)",
              }}
            >
              {/* Card header */}
              <div
                style={{
                  padding: "0.65rem 1rem",
                  borderBottom: "1px solid var(--border)",
                  background: "var(--bg)",
                  display: "flex",
                  justifyContent: "space-between",
                  alignItems: "center",
                }}
              >
                <span
                  style={{
                    fontFamily: "var(--display)",
                    fontSize: "0.7rem",
                    color: "var(--orange)",
                    letterSpacing: "0.15em",
                  }}
                >
                  LIVE ORACLE
                </span>
                <span
                  style={{
                    fontSize: "0.48rem",
                    color: "var(--green)",
                    letterSpacing: "0.15em",
                    display: "flex",
                    alignItems: "center",
                    gap: "0.35rem",
                  }}
                >
                  <span
                    style={{
                      width: 5,
                      height: 5,
                      borderRadius: "50%",
                      background: "var(--green)",
                      display: "block",
                      boxShadow: "0 0 4px var(--green)",
                    }}
                  />
                  CHAINLINK + PRAGMA
                </span>
              </div>

              {/* Price */}
              <div style={{ padding: "2rem 1rem", textAlign: "center" }}>
                <div
                  style={{
                    fontSize: "0.52rem",
                    color: "var(--muted)",
                    letterSpacing: "0.2em",
                    marginBottom: "0.5rem",
                  }}
                >
                  BTC / USD
                </div>
                <div
                  style={{
                    fontFamily: "var(--display)",
                    fontSize: "3.5rem",
                    color: "var(--orange)",
                    letterSpacing: "0.04em",
                    lineHeight: 1,
                    animation: "number-flip 0.4s ease",
                  }}
                >
                  {btcFormatted}
                </div>
                <div
                  style={{
                    fontSize: "0.55rem",
                    color: "var(--muted2)",
                    marginTop: "0.75rem",
                    letterSpacing: "0.08em",
                  }}
                >
                  Sepolia testnet · updates every 30s
                </div>
              </div>

              {/* STRK row */}
              <div
                style={{
                  borderTop: "1px solid var(--border)",
                  padding: "0.75rem 1rem",
                  display: "flex",
                  justifyContent: "space-between",
                  alignItems: "center",
                }}
              >
                <span
                  style={{
                    fontSize: "0.58rem",
                    color: "var(--muted)",
                    letterSpacing: "0.08em",
                  }}
                >
                  STRK / USD
                </span>
                <span
                  style={{
                    fontSize: "0.72rem",
                    color: "var(--text)",
                    fontFamily: "var(--mono)",
                  }}
                >
                  {strkPrice ? `$${(strkPrice / 1e8).toFixed(4)}` : "—"}
                </span>
              </div>
            </div>

            {/* Subcard: keeper fee */}
            <div
              style={{
                border: "1px solid var(--border)",
                borderTop: "none",
                background: "var(--bg)",
                padding: "0.75rem 1rem",
                display: "flex",
                justifyContent: "space-between",
                alignItems: "center",
              }}
            >
              <span
                style={{
                  fontSize: "0.56rem",
                  color: "var(--muted2)",
                  letterSpacing: "0.08em",
                }}
              >
                KEEPER FEE PER INTERVAL
              </span>
              <span style={{ fontSize: "0.7rem", color: "var(--text2)" }}>
                0.5 STRK
              </span>
            </div>
          </div>
        </section>

        {/* ── Divider ────────────────────────────────────────────────────── */}
        <div style={{ borderTop: "1px solid var(--border)" }} />

        {/* ── How it works ───────────────────────────────────────────────── */}
        <section
          style={{ maxWidth: 900, margin: "0 auto", padding: "4rem 1.5rem" }}
        >
          <div
            style={{
              fontFamily: "var(--display)",
              fontSize: "0.7rem",
              color: "var(--muted)",
              letterSpacing: "0.25em",
              marginBottom: "2.5rem",
            }}
          >
            HOW IT WORKS
          </div>

          <div
            style={{
              display: "grid",
              gridTemplateColumns: "repeat(3, 1fr)",
              gap: "1px",
              background: "var(--border)",
            }}
          >
            {STEPS.map((step, i) => (
              <div
                key={step.n}
                style={{
                  background: "var(--surface)",
                  padding: "1.75rem 1.5rem",
                  animation: `hero-reveal 0.5s ${0.1 * i}s ease both`,
                  opacity: 0,
                }}
              >
                <div
                  style={{
                    fontFamily: "var(--display)",
                    fontSize: "3rem",
                    color: "rgba(247,147,26,0.15)",
                    lineHeight: 1,
                    marginBottom: "1rem",
                    letterSpacing: "0.04em",
                  }}
                >
                  {step.n}
                </div>
                <div
                  style={{
                    fontFamily: "var(--display)",
                    fontSize: "0.82rem",
                    color: "var(--orange)",
                    letterSpacing: "0.12em",
                    marginBottom: "0.85rem",
                  }}
                >
                  {step.title}
                </div>
                <p
                  style={{
                    fontSize: "0.62rem",
                    color: "var(--muted)",
                    lineHeight: 1.85,
                    letterSpacing: "0.04em",
                  }}
                >
                  {step.body}
                </p>
              </div>
            ))}
          </div>
        </section>

        {/* ── Divider ────────────────────────────────────────────────────── */}
        <div style={{ borderTop: "1px solid var(--border)" }} />

        {/* ── Features grid ──────────────────────────────────────────────── */}
        <section
          style={{ maxWidth: 900, margin: "0 auto", padding: "4rem 1.5rem" }}
        >
          <div
            style={{
              fontFamily: "var(--display)",
              fontSize: "0.7rem",
              color: "var(--muted)",
              letterSpacing: "0.25em",
              marginBottom: "2rem",
            }}
          >
            FEATURES
          </div>
          <div
            style={{
              display: "grid",
              gridTemplateColumns: "repeat(3, 1fr)",
              gap: "1px",
              background: "var(--border)",
            }}
          >
            {FEATURES.map(({ label, sub }) => (
              <div
                key={label}
                style={{
                  background: "var(--surface)",
                  padding: "1.25rem 1.5rem",
                  display: "flex",
                  flexDirection: "column",
                  gap: "0.3rem",
                }}
              >
                <div
                  style={{
                    display: "flex",
                    alignItems: "center",
                    gap: "0.5rem",
                  }}
                >
                  <span style={{ color: "var(--orange)", fontSize: "0.6rem" }}>
                    →
                  </span>
                  <span
                    style={{
                      fontSize: "0.7rem",
                      color: "var(--text)",
                      letterSpacing: "0.06em",
                    }}
                  >
                    {label}
                  </span>
                </div>
                <span
                  style={{
                    fontSize: "0.55rem",
                    color: "var(--muted)",
                    letterSpacing: "0.06em",
                    paddingLeft: "1rem",
                  }}
                >
                  {sub}
                </span>
              </div>
            ))}
          </div>
        </section>

        {/* ── Bottom CTA ─────────────────────────────────────────────────── */}
        <section
          style={{
            borderTop: "1px solid var(--border)",
            padding: "4rem 1.5rem",
            textAlign: "center",
            background: "var(--surface)",
          }}
        >
          <div
            style={{
              fontFamily: "var(--display)",
              fontSize: "clamp(1.8rem, 5vw, 3rem)",
              color: "var(--text)",
              letterSpacing: "0.04em",
              marginBottom: "1rem",
              lineHeight: 1.1,
            }}
          >
            NATIVE BTC ON A SCHEDULE.
            <br />
            <span style={{ color: "var(--orange)" }}>THAT'S HERMES.</span>
          </div>
          <p
            style={{
              fontSize: "0.68rem",
              color: "var(--muted)",
              letterSpacing: "0.06em",
              marginBottom: "2rem",
            }}
          >
            Starknet Sepolia · Unaudited testnet demo
          </p>
          <button
            onClick={() => navigate("/app")}
            style={{
              background: "var(--orange)",
              color: "#000",
              border: "1px solid var(--orange)",
              padding: "0.9rem 2.5rem",
              fontSize: "0.78rem",
              fontWeight: 700,
              letterSpacing: "0.12em",
              textTransform: "uppercase",
              fontFamily: "var(--mono)",
              borderRadius: 3,
              cursor: "pointer",
              animation: "glow-pulse 3s ease infinite",
            }}
          >
            Open App →
          </button>
        </section>

        {/* ── Footer ─────────────────────────────────────────────────────── */}
        <footer
          style={{
            borderTop: "1px solid var(--border)",
            padding: "1rem 1.5rem",
            display: "flex",
            justifyContent: "space-between",
            alignItems: "center",
            background: "var(--bg)",
          }}
        >
          <span
            style={{
              fontFamily: "var(--display)",
              fontSize: "0.85rem",
              color: "var(--muted2)",
              letterSpacing: "0.12em",
            }}
          >
            HERMES
          </span>
          <span
            style={{
              fontSize: "0.5rem",
              color: "var(--muted2)",
              letterSpacing: "0.15em",
            }}
          >
            STARKNET SEPOLIA · UNAUDITED · DO NOT USE WITH REAL FUNDS
          </span>
          <span
            style={{
              fontSize: "0.5rem",
              color: "var(--muted2)",
              letterSpacing: "0.12em",
            }}
          >
            CHAINLINK + PRAGMA · ATOMIQ
          </span>
        </footer>
      </div>
    </>
  );
}
