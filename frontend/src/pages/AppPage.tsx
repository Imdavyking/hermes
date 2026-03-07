import { useState } from "react";
import { useReadContract } from "@starknet-react/core";
import abi from "../assets/json/abi";
import { CONTRACT_ADDRESS } from "../utils/constants";
import Scanline from "../components/layout/Scanline";
import Header from "../components/layout/Header";
import PriceTicker from "../components/layout/PriceTicker";
import CreateForm from "../components/dca/CreateForm";
import OrdersPanel from "../components/dca/OrdersPanel";
import { Section, StatCell } from "../components/ui/Layout";

const fmtStrk = (raw: bigint) =>
  (Number(raw) / 1e18).toLocaleString(undefined, { maximumFractionDigits: 4 }) +
  " STRK";

type AppTab = "create" | "orders";

const TABS: { key: AppTab; label: string }[] = [
  { key: "create", label: "NEW ORDER" },
  { key: "orders", label: "MY ORDERS" },
];

const INFO_CARDS = [
  {
    title: "HOW IT WORKS",
    body: "Deposit USDC + STRK keeper fee upfront. A keeper fires execute_dca each interval, committing STRK to an Atomiq escrow that routes native BTC to your Bitcoin address.",
  },
  {
    title: "KEEPER",
    body: "Zero capital, zero approvals. checker() returns can_exec + live strk_amount pre-computed on-chain. Keeper needs no oracle math or additional config.",
  },
  {
    title: "SAFETY",
    body: "5% STRK tolerance prevents manipulation. dca_interval_needs_refund blocks double-execution. Cancel anytime — unspent USDC + STRK fee reserve returned in full.",
  },
];

export default function AppPage() {
  const [tab, setTab] = useState<AppTab>("create");

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
  const { data: keeperFeeData } = useReadContract({
    abi,
    address: CONTRACT_ADDRESS,
    functionName: "keeper_fee_strk",
    args: [],
  });

  const btcPrice = btcPriceData ? Number((btcPriceData as any)[0]) : 0;
  const strkPrice = strkPriceData ? Number((strkPriceData as any)[0]) : 0;
  const keeperFee: bigint = keeperFeeData
    ? BigInt((keeperFeeData as any).toString())
    : BigInt("500000000000000000");
  const btcUsd = btcPrice ? btcPrice / 1e8 : null;

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

        <main
          style={{
            maxWidth: 860,
            margin: "0 auto",
            padding: "1.5rem 1rem 4rem",
          }}
        >
          {/* ── Stat row ─────────────────────────────────────────────────── */}
          <div
            style={{
              display: "grid",
              gridTemplateColumns: "repeat(4, 1fr)",
              gap: "1px",
              background: "var(--border)",
              border: "1px solid var(--border)",
              marginBottom: "1.5rem",
            }}
          >
            <StatCell
              label="BTC / USD"
              value={
                btcPrice
                  ? `$${(btcPrice / 1e8).toLocaleString(undefined, { maximumFractionDigits: 0 })}`
                  : "—"
              }
              accent
              large
            />
            <StatCell
              label="STRK / USD"
              value={strkPrice ? `$${(strkPrice / 1e8).toFixed(4)}` : "—"}
              large
            />
            <StatCell label="Keeper fee" value={fmtStrk(keeperFee)} />
            <StatCell label="Network" value="SEPOLIA" />
          </div>

          {/* ── Tab nav ───────────────────────────────────────────────────── */}
          <div
            style={{
              display: "grid",
              gridTemplateColumns: "1fr 1fr",
              border: "1px solid var(--border)",
              background: "var(--border)",
              gap: "1px",
              marginBottom: "1.5rem",
            }}
          >
            {TABS.map(({ key, label }) => {
              const active = tab === key;
              return (
                <button
                  key={key}
                  onClick={() => setTab(key)}
                  style={{
                    background: active ? "var(--surface)" : "var(--bg)",
                    color: active ? "var(--orange)" : "var(--muted)",
                    border: "none",
                    padding: "0.88rem 1.25rem",
                    fontFamily: "var(--display)",
                    fontSize: "0.9rem",
                    letterSpacing: "0.12em",
                    borderBottom: active
                      ? "2px solid var(--orange)"
                      : "2px solid transparent",
                    cursor: "pointer",
                    transition: "all 0.15s",
                    textAlign: "left",
                  }}
                >
                  {label}
                </button>
              );
            })}
          </div>

          {/* ── Tab content ───────────────────────────────────────────────── */}
          {tab === "create" && (
            <Section
              title="Schedule BTC Purchase"
              tag="USDC → NATIVE BTC VIA ATOMIQ"
            >
              <CreateForm keeperFee={keeperFee} btcUsd={btcUsd} />
            </Section>
          )}
          {tab === "orders" && (
            <Section title="Active DCA Orders" tag="GELATO-STYLE KEEPER">
              <OrdersPanel keeperFee={keeperFee} btcUsd={btcUsd} />
            </Section>
          )}

          {/* ── Info strip ────────────────────────────────────────────────── */}
          <div
            style={{
              display: "grid",
              gridTemplateColumns: "repeat(3, 1fr)",
              gap: "1px",
              background: "var(--border)",
              border: "1px solid var(--border)",
              marginTop: "1.5rem",
            }}
          >
            {INFO_CARDS.map(({ title, body }) => (
              <div
                key={title}
                style={{ background: "var(--surface)", padding: "1.1rem" }}
              >
                <div
                  style={{
                    fontFamily: "var(--display)",
                    fontSize: "0.72rem",
                    color: "var(--orange)",
                    letterSpacing: "0.15em",
                    marginBottom: "0.55rem",
                  }}
                >
                  {title}
                </div>
                <p
                  style={{
                    fontSize: "0.6rem",
                    color: "var(--muted)",
                    lineHeight: 1.85,
                    letterSpacing: "0.04em",
                  }}
                >
                  {body}
                </p>
              </div>
            ))}
          </div>
        </main>

        {/* ── Footer ────────────────────────────────────────────────────── */}
        <footer
          style={{
            borderTop: "1px solid var(--border)",
            padding: "0.9rem 1.5rem",
            display: "flex",
            justifyContent: "space-between",
            alignItems: "center",
            background: "var(--surface)",
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
