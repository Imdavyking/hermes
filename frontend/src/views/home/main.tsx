import { useEffect, useState } from "react";
import { useAccount, useReadContract, useContract } from "@starknet-react/core";
import { RiShieldKeyholeFill, RiExchangeLine } from "react-icons/ri";
import { CONTRACT_ADDRESS } from "../../utils/constants";
import abi from "../../assets/json/abi";
import { type Tab, StatCard, hexRoot, shortenAddress } from "./shared";
import DepositTab from "./deposit-tab";
import WithdrawTab from "./withdraw-tab";
import SwapTab from "./swap-tab";

// Extend Tab type to include swap
type AppTab = "deposit" | "withdraw" | "swap";

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

export default function UmbraHome() {
  const { address } = useAccount();
  const [tab, setTab] = useState<AppTab>("swap");
  const [wBTCBalance, setwBTCBalance] = useState<number | null>(null);
  const [strkBalance, setStrkBalance] = useState<number | null>(null);

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
    ? `$${(Number((btcPrice as any)[0]) / 1e8).toLocaleString(undefined, { maximumFractionDigits: 8 })}`
    : "—";
  const payoutDisplay = btcRate
    ? `${BigInt(((btcRate as bigint) / 10n ** 18n).toString())} STRK`
    : "—";
  const wBTCDisplay =
    wBTCBalance != null ? `${Number(wBTCBalance).toFixed(8)}` : "—";
  const strkDisplay =
    strkBalance != null ? `${Number(strkBalance).toFixed(4)}` : "—";

  const TABS: { key: AppTab; label: string; icon?: React.ReactNode }[] = [
    { key: "deposit", label: "↓  Deposit" },
    { key: "withdraw", label: "↑  Withdraw" },
    {
      key: "swap",
      label: "⇄  P2P Swap",
      icon: <RiExchangeLine size={11} style={{ verticalAlign: "middle" }} />,
    },
  ];

  return (
    <div
      style={{
        minHeight: "100vh",
        background: "#0a0a0f",
        color: "#fff",
        fontFamily: "'DM Mono', 'Courier New', monospace",
        overflowX: "hidden",
      }}
    >
      {/* Grid background */}
      <div
        style={{
          position: "fixed",
          inset: 0,
          backgroundImage: `linear-gradient(rgba(255,200,0,0.025) 1px, transparent 1px), linear-gradient(90deg, rgba(255,200,0,0.025) 1px, transparent 1px)`,
          backgroundSize: "48px 48px",
          pointerEvents: "none",
          zIndex: 0,
        }}
      />
      {/* Glow */}
      <div
        style={{
          position: "fixed",
          top: "-15%",
          left: "50%",
          transform: "translateX(-50%)",
          width: "55vw",
          height: "55vw",
          borderRadius: "50%",
          background:
            "radial-gradient(circle, rgba(255,200,0,0.045) 0%, transparent 65%)",
          pointerEvents: "none",
          zIndex: 0,
        }}
      />

      <div
        style={{
          position: "relative",
          zIndex: 1,
          maxWidth: 600,
          margin: "0 auto",
          padding: "3rem 1.5rem 6rem",
        }}
      >
        {/* Header */}
        <header style={{ textAlign: "center", marginBottom: "2.5rem" }}>
          <div
            style={{
              display: "inline-flex",
              alignItems: "center",
              gap: "0.5rem",
              fontSize: "0.65rem",
              letterSpacing: "0.25em",
              textTransform: "uppercase",
              color: "#ffc800",
              border: "1px solid rgba(255,200,0,0.22)",
              borderRadius: 2,
              padding: "0.2rem 0.75rem",
              marginBottom: "1.25rem",
            }}
          >
            <RiShieldKeyholeFill size={11} />
            Umbra · Private BTC Swap
          </div>
          <h1
            style={{
              fontSize: "clamp(2.4rem, 8vw, 4rem)",
              fontWeight: 900,
              letterSpacing: "-0.04em",
              margin: 0,
              lineHeight: 1.0,
            }}
          >
            Deposit BTC.
            <br />
            <span style={{ color: "#ffc800" }}>Vanish.</span>
          </h1>
          <p
            style={{
              color: "#3a3a4a",
              fontSize: "0.78rem",
              marginTop: "0.85rem",
              letterSpacing: "0.05em",
              lineHeight: 1.7,
            }}
          >
            ZK proof on Starknet · Poseidon2 Merkle tree · Pragma oracle rate
          </p>
          {address && (
            <div
              style={{
                display: "inline-block",
                marginTop: "0.75rem",
                fontSize: "0.62rem",
                color: "#22c55e",
                border: "1px solid rgba(34,197,94,0.2)",
                borderRadius: 4,
                padding: "0.2rem 0.7rem",
                letterSpacing: "0.1em",
              }}
            >
              ● {shortenAddress(address)}
            </div>
          )}
        </header>

        {/* Pool stats */}
        <div
          style={{
            display: "grid",
            gridTemplateColumns: "1fr 1fr 1fr 1fr",
            gap: "0.6rem",
            marginBottom: "0.6rem",
          }}
        >
          <StatCard label="Pool depth" value={poolDepositCount} />
          <StatCard label="BTC/USD" value={btcPriceDisplay} highlight />
          <StatCard
            label="1 wBTC →"
            value={
              btcRate
                ? `${BigInt(((btcRate as bigint) / 10n ** 18n).toString()).toLocaleString(undefined, { maximumFractionDigits: 8 })} STRK`
                : "—"
            }
            highlight
          />
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
              gap: "0.6rem",
              marginBottom: "1.75rem",
            }}
          >
            <StatCard label="Your wBTC" value={wBTCDisplay} />
            <StatCard label="Your STRK" value={strkDisplay} />
          </div>
        )}
        {!address && <div style={{ marginBottom: "1.75rem" }} />}

        {/* Tabs — 3 columns */}
        <div
          style={{
            display: "grid",
            gridTemplateColumns: "1fr 1fr 1fr",
            background: "#111118",
            border: "1px solid #1e1e2e",
            borderRadius: 10,
            padding: 4,
            marginBottom: "1.5rem",
            gap: 4,
          }}
        >
          {TABS.map(({ key, label }) => (
            <button
              key={key}
              onClick={() => setTab(key)}
              style={{
                background: tab === key ? "#1e1e2e" : "transparent",
                color: tab === key ? "#ffc800" : "#3a3a4a",
                border:
                  tab === key ? "1px solid #2a2a3a" : "1px solid transparent",
                borderRadius: 8,
                padding: "0.7rem",
                fontSize: "0.7rem",
                fontFamily: "'DM Mono', monospace",
                fontWeight: 700,
                letterSpacing: "0.1em",
                textTransform: "uppercase",
                cursor: "pointer",
                transition: "all 0.18s",
              }}
            >
              {label}
            </button>
          ))}
        </div>

        {/* Tab content */}
        {tab === "deposit" && <DepositTab payoutDisplay={payoutDisplay} />}
        {tab === "withdraw" && <WithdrawTab payoutDisplay={payoutDisplay} />}
        {tab === "swap" && <SwapTab />}

        {/* Footer */}
        <footer
          style={{
            marginTop: "3.5rem",
            textAlign: "center",
            color: "#1e1e2e",
            fontSize: "0.58rem",
            letterSpacing: "0.18em",
            textTransform: "uppercase",
          }}
        >
          Umbra · Starknet Sepolia · Powered by Garaga + Pragma + Noir
        </footer>
      </div>

      <style>{`
        @import url('https://fonts.googleapis.com/css2?family=DM+Mono:ital,wght@0,300;0,400;0,500;1,300;1,400;1,500&display=swap');
        @keyframes spin { to { transform: rotate(360deg); } }
        * { box-sizing: border-box; }
        textarea, input { caret-color: #ffc800; }
        ::selection { background: rgba(255,200,0,0.18); }
        ::-webkit-scrollbar { width: 4px; }
        ::-webkit-scrollbar-track { background: #0a0a0f; }
        ::-webkit-scrollbar-thumb { background: #1e1e2e; border-radius: 2px; }
        button { font-family: 'DM Mono', monospace; }
      `}</style>
    </div>
  );
}
