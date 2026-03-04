import { useEffect, useState } from "react";
import { useAccount, useReadContract, useContract } from "@starknet-react/core";
import { RiShieldKeyholeFill } from "react-icons/ri";
import { CONTRACT_ADDRESS } from "../../utils/constants";
import abi from "../../assets/json/abi";
import { StatCard, hexRoot, shortenAddress } from "./shared";
import DepositTab from "./deposit-tab";
import DCATab from "./dca-tab";
import WithdrawTab from "./withdraw-tab";
import SwapTab from "./swap-tab";
import YieldTab from "./yield-tab";

type AppTab = "deposit" | "withdraw" | "swap" | "yield" | "dca";

const erc20Abi = [
  {
    name: "balance_of",
    type: "function",
    inputs: [
      {
        name: "account",
        type: "core::starknet::contract_address::ContractAddress",
      },
    ],
    outputs: [{ type: "core::integer::u256" }],
    state_mutability: "view",
  },
  {
    name: "decimals",
    type: "function",
    inputs: [],
    outputs: [{ type: "core::integer::u8" }],
    state_mutability: "view",
  },
] as const;

const TABS: { key: AppTab; label: string; icon: string; desc: string }[] = [
  { key: "dca", label: "DCA", icon: "↻", desc: "USDC → real BTC" },
  { key: "swap", label: "Swap", icon: "⇄", desc: "wBTC ↔ STRK" },
  { key: "deposit", label: "Deposit", icon: "↓", desc: "Private pool" },
  { key: "withdraw", label: "Withdraw", icon: "↑", desc: "ZK exit" },
  { key: "yield", label: "Yield", icon: "🌱", desc: "Earn on wBTC" },
];

export default function UmbraHome() {
  const { address } = useAccount();
  const [tab, setTab] = useState<AppTab>("dca");
  const [wBTCBalance, setwBTCBalance] = useState<number | null>(null);
  const [strkBalance, setStrkBalance] = useState<number | null>(null);
  const [mounted, setMounted] = useState(false);

  useEffect(() => {
    setMounted(true);
  }, []);

  const { data: currentRoot } = useReadContract({
    abi,
    address: CONTRACT_ADDRESS,
    functionName: "current_root",
    args: [],
    watch: true,
    refetchInterval: 8000,
  });
  const { data: leafCount } = useReadContract({
    abi,
    address: CONTRACT_ADDRESS,
    functionName: "next_leaf_index",
    args: [],
    watch: true,
    refetchInterval: 8000,
  });
  const { data: btcRate } = useReadContract({
    abi,
    address: CONTRACT_ADDRESS,
    functionName: "get_btc_strk_rate",
    args: [],
    watch: true,
    refetchInterval: 30000,
  });
  const { data: btcPrice } = useReadContract({
    abi,
    address: CONTRACT_ADDRESS,
    functionName: "get_btc_usd_price",
    args: [],
    watch: true,
    refetchInterval: 30000,
  });
  const { data: wBTCAddress } = useReadContract({
    abi,
    address: CONTRACT_ADDRESS,
    functionName: "wBTC_address",
    args: [],
  });
  const { data: strkAddress } = useReadContract({
    abi,
    address: CONTRACT_ADDRESS,
    functionName: "strk_address",
    args: [],
  });
  const { data: quotedStrkRaw } = useReadContract({
    abi,
    address: CONTRACT_ADDRESS,
    functionName: "get_quoted_strk_amount",
    args: [],
    watch: true,
    refetchInterval: 30000,
  });

  const { contract: erc20Contract } = useContract({
    abi: erc20Abi,
    address: CONTRACT_ADDRESS,
  });

  useEffect(() => {
    if (!address || !erc20Contract || !wBTCAddress || !strkAddress) return;
    const fetchBalances = async () => {
      try {
        for (let i = 0; i < 2; i++) {
          const tokenAddress = i === 0 ? wBTCAddress : strkAddress;
          erc20Contract.address =
            `0x${BigInt(tokenAddress.toString()).toString(16)}` as `0x${string}`;
          const balance = await erc20Contract.call("balance_of", [address], {
            parseResponse: true,
          });
          const decimals = await erc20Contract.call("decimals", [], {
            parseResponse: true,
          });
          const finalBal =
            Number(balance.toString()) / Number(10) ** Number(decimals);
          if (i === 0) setwBTCBalance(finalBal);
          else setStrkBalance(finalBal);
        }
      } catch (err) {
        console.error("Failed to fetch balances:", err);
      }
    };
    fetchBalances();
    const interval = setInterval(fetchBalances, 8000);
    return () => clearInterval(interval);
  }, [address, erc20Contract, wBTCAddress, strkAddress]);

  const poolDepositCount = leafCount ? Number(leafCount) : 0;
  const btcPriceDisplay = btcPrice
    ? `$${(Number((btcPrice as any)[0]) / 1e8).toLocaleString(undefined, { maximumFractionDigits: 0 })}`
    : "—";
  const payoutDisplay = quotedStrkRaw
    ? `${(Number(quotedStrkRaw as bigint) / 1e18).toLocaleString(undefined, { maximumFractionDigits: 4 })} STRK`
    : "—";
  const wBTCDisplay =
    wBTCBalance != null ? `${Number(wBTCBalance).toFixed(8)}` : "—";
  const strkDisplay =
    strkBalance != null ? `${Number(strkBalance).toFixed(4)}` : "—";

  return (
    <div
      style={{
        minHeight: "100vh",
        background: "#080810",
        color: "#fff",
        fontFamily: "'DM Mono', 'Courier New', monospace",
        overflowX: "hidden",
      }}
    >
      {/* Animated grid */}
      <div
        style={{
          position: "fixed",
          inset: 0,
          zIndex: 0,
          backgroundImage: `
          linear-gradient(rgba(255,200,0,0.03) 1px, transparent 1px),
          linear-gradient(90deg, rgba(255,200,0,0.03) 1px, transparent 1px)
        `,
          backgroundSize: "48px 48px",
          pointerEvents: "none",
        }}
      />

      {/* Top glow */}
      <div
        style={{
          position: "fixed",
          top: "-20%",
          left: "50%",
          transform: "translateX(-50%)",
          width: "60vw",
          height: "60vw",
          borderRadius: "50%",
          background:
            "radial-gradient(circle, rgba(255,200,0,0.06) 0%, transparent 60%)",
          pointerEvents: "none",
          zIndex: 0,
        }}
      />

      {/* BTC corner accent — top right */}
      <div
        style={{
          position: "fixed",
          top: 24,
          right: 24,
          zIndex: 0,
          opacity: 0.04,
          fontSize: "12rem",
          lineHeight: 1,
          color: "#f7931a",
          pointerEvents: "none",
          fontWeight: 900,
          letterSpacing: "-0.05em",
        }}
      >
        ₿
      </div>

      <div
        style={{
          position: "relative",
          zIndex: 1,
          maxWidth: 620,
          margin: "0 auto",
          padding: "3rem 1.5rem 6rem",
          opacity: mounted ? 1 : 0,
          transition: "opacity 0.4s ease",
        }}
      >
        {/* ── Header ───────────────────────────────────────────── */}
        <header style={{ textAlign: "center", marginBottom: "2.5rem" }}>
          {/* Badge */}
          <div
            style={{
              display: "inline-flex",
              alignItems: "center",
              gap: "0.5rem",
              fontSize: "0.6rem",
              letterSpacing: "0.25em",
              textTransform: "uppercase",
              color: "#ffc800",
              border: "1px solid rgba(255,200,0,0.2)",
              borderRadius: 2,
              padding: "0.25rem 0.9rem",
              marginBottom: "1.5rem",
              background: "rgba(255,200,0,0.04)",
            }}
          >
            <RiShieldKeyholeFill size={10} />
            Umbra · Private Bitcoin DeFi · Starknet
          </div>

          {/* Hero headline */}
          <h1
            style={{
              fontSize: "clamp(2.6rem, 9vw, 4.4rem)",
              fontWeight: 900,
              letterSpacing: "-0.05em",
              margin: 0,
              lineHeight: 1.0,
            }}
          >
            Real BTC.
            <br />
            <span style={{ color: "#ffc800" }}>Your Wallet.</span>
          </h1>

          {/* Subheadline */}
          <p
            style={{
              color: "#444460",
              fontSize: "0.75rem",
              marginTop: "1rem",
              letterSpacing: "0.04em",
              lineHeight: 1.9,
            }}
          >
            Schedule USDC → Bitcoin purchases delivered to your wallet
            <br />
            <span style={{ color: "#2a2a3e" }}>
              ZK privacy · Chainlink oracle · Atomic swaps · No wrapped tokens
            </span>
          </p>

          {/* Feature pills */}
          <div
            style={{
              display: "flex",
              justifyContent: "center",
              flexWrap: "wrap",
              gap: "0.5rem",
              marginTop: "1.2rem",
            }}
          >
            {[
              { label: "Native BTC delivery", color: "#f7931a" },
              { label: "ZK anonymous", color: "#a78bfa" },
              { label: "Non-custodial", color: "#22c55e" },
              { label: "Chainlink oracle", color: "#3b82f6" },
            ].map(({ label, color }) => (
              <span
                key={label}
                style={{
                  fontSize: "0.58rem",
                  letterSpacing: "0.1em",
                  color,
                  background: `${color}12`,
                  border: `1px solid ${color}30`,
                  borderRadius: 3,
                  padding: "0.15rem 0.6rem",
                  textTransform: "uppercase",
                }}
              >
                {label}
              </span>
            ))}
          </div>

          {/* Connected address */}
          {address && (
            <div
              style={{
                display: "inline-block",
                marginTop: "1rem",
                fontSize: "0.6rem",
                color: "#22c55e",
                border: "1px solid rgba(34,197,94,0.2)",
                borderRadius: 4,
                padding: "0.2rem 0.75rem",
                letterSpacing: "0.1em",
                background: "rgba(34,197,94,0.04)",
              }}
            >
              ● {shortenAddress(address)}
            </div>
          )}
        </header>

        {/* ── Stats row ────────────────────────────────────────── */}
        <div
          style={{
            display: "grid",
            gridTemplateColumns: "1fr 1fr 1fr 1fr",
            gap: "0.5rem",
            marginBottom: "0.5rem",
          }}
        >
          <StatCard label="BTC/USD" value={btcPriceDisplay} highlight />
          <StatCard
            label="1 wBTC →"
            value={
              btcRate
                ? `${BigInt(((btcRate as bigint) / 10n ** 18n).toString()).toLocaleString()} STRK`
                : "—"
            }
            highlight
          />
          <StatCard label="Pool depth" value={poolDepositCount} />
          <StatCard
            label="Merkle root"
            value={currentRoot ? hexRoot(currentRoot) : "—"}
          />
        </div>

        {/* Wallet balances */}
        {address && (
          <div
            style={{
              display: "grid",
              gridTemplateColumns: "1fr 1fr",
              gap: "0.5rem",
              marginBottom: "1.75rem",
            }}
          >
            <StatCard label="Your wBTC" value={wBTCDisplay} />
            <StatCard label="Your STRK" value={strkDisplay} />
          </div>
        )}
        {!address && <div style={{ marginBottom: "1.75rem" }} />}

        {/* ── Tab nav ──────────────────────────────────────────── */}
        <div
          style={{
            display: "grid",
            gridTemplateColumns: "repeat(5, 1fr)",
            background: "#0e0e18",
            border: "1px solid #1a1a28",
            borderRadius: 12,
            padding: 4,
            marginBottom: "1.5rem",
            gap: 4,
          }}
        >
          {TABS.map(({ key, label, icon, desc }) => {
            const isActive = tab === key;
            const accentColor =
              key === "yield"
                ? "#22c55e"
                : key === "dca"
                  ? "#f7931a"
                  : "#ffc800";
            return (
              <button
                key={key}
                onClick={() => setTab(key)}
                style={{
                  background: isActive ? "#16162a" : "transparent",
                  color: isActive ? accentColor : "#333348",
                  border: isActive
                    ? `1px solid ${accentColor}30`
                    : "1px solid transparent",
                  borderRadius: 8,
                  padding: "0.65rem 0.3rem 0.5rem",
                  fontSize: "0.62rem",
                  fontFamily: "'DM Mono', monospace",
                  fontWeight: 700,
                  letterSpacing: "0.06em",
                  textTransform: "uppercase",
                  cursor: "pointer",
                  transition: "all 0.15s",
                  display: "flex",
                  flexDirection: "column",
                  alignItems: "center",
                  gap: "0.15rem",
                  lineHeight: 1.3,
                }}
              >
                <span style={{ fontSize: "1rem", lineHeight: 1 }}>{icon}</span>
                <span>{label}</span>
                <span
                  style={{
                    fontSize: "0.48rem",
                    color: isActive ? `${accentColor}99` : "#222234",
                    letterSpacing: "0.04em",
                    fontWeight: 400,
                    textTransform: "none",
                  }}
                >
                  {desc}
                </span>
              </button>
            );
          })}
        </div>

        {/* ── Active tab indicator bar ─────────────────────────── */}
        <div
          style={{
            height: 2,
            background: "#0e0e18",
            borderRadius: 1,
            marginBottom: "1.5rem",
            overflow: "hidden",
            position: "relative",
          }}
        >
          <div
            style={{
              position: "absolute",
              height: "100%",
              width: `${100 / TABS.length}%`,
              left: `${(TABS.findIndex((t) => t.key === tab) / TABS.length) * 100}%`,
              background:
                tab === "yield"
                  ? "#22c55e"
                  : tab === "dca"
                    ? "#f7931a"
                    : "#ffc800",
              borderRadius: 1,
              transition: "left 0.25s cubic-bezier(0.4,0,0.2,1)",
            }}
          />
        </div>

        {/* ── Tab content ──────────────────────────────────────── */}
        <div style={{ animation: "fadeIn 0.2s ease" }}>
          {tab === "dca" && <DCATab />}
          {tab === "swap" && <SwapTab />}
          {tab === "deposit" && <DepositTab payoutDisplay={payoutDisplay} />}
          {tab === "withdraw" && <WithdrawTab />}
          {tab === "yield" && <YieldTab />}
        </div>

        {/* ── Footer ───────────────────────────────────────────── */}
        <footer
          style={{
            marginTop: "3.5rem",
            textAlign: "center",
            color: "#1a1a28",
            fontSize: "0.55rem",
            letterSpacing: "0.18em",
            textTransform: "uppercase",
            lineHeight: 2,
          }}
        >
          <div>Umbra · Starknet Sepolia</div>
          <div style={{ color: "#141420" }}>
            Noir · Garaga · Chainlink · Vesu · Atomiq
          </div>
        </footer>
      </div>

      <style>{`
        @import url('https://fonts.googleapis.com/css2?family=DM+Mono:ital,wght@0,300;0,400;0,500;1,300;1,400;1,500&display=swap');

        @keyframes spin    { to { transform: rotate(360deg); } }
        @keyframes fadeIn  { from { opacity: 0; transform: translateY(4px); } to { opacity: 1; transform: none; } }
        @keyframes pulse   { 0%,100% { opacity:1; } 50% { opacity:0.4; } }

        * { box-sizing: border-box; }
        textarea, input { caret-color: #ffc800; }
        ::selection { background: rgba(255,200,0,0.15); }
        ::-webkit-scrollbar { width: 4px; }
        ::-webkit-scrollbar-track { background: #080810; }
        ::-webkit-scrollbar-thumb { background: #1a1a28; border-radius: 2px; }
        button { font-family: 'DM Mono', monospace; }
      `}</style>
    </div>
  );
}
