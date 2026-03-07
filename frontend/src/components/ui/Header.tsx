import { useState, useEffect } from "react";
import { useNavigate, useLocation } from "react-router-dom";

const shortenAddr = (a: string) => a?.slice(0, 8) + "…" + a?.slice(-6);

interface HeaderProps {
  address?: string;
  btcPrice: number;
}

export default function Header({ address, btcPrice }: HeaderProps) {
  const [time, setTime] = useState(new Date());
  const navigate = useNavigate();
  const location = useLocation();
  const isApp = location.pathname === "/app";

  useEffect(() => {
    const t = setInterval(() => setTime(new Date()), 1000);
    return () => clearInterval(t);
  }, []);

  return (
    <header style={{
      display: "flex",
      alignItems: "stretch",
      borderBottom: "1px solid var(--border)",
      background: "var(--surface)",
      position: "sticky",
      top: 0,
      zIndex: 100,
      fontFamily: "var(--mono)",
    }}>
      {/* Logo */}
      <button
        onClick={() => navigate("/")}
        style={{
          display: "flex", alignItems: "center", gap: "0.75rem",
          padding: "0.85rem 1.4rem",
          borderRight: "1px solid var(--border)",
          background: "transparent",
          cursor: "pointer",
        }}
      >
        <span style={{
          fontFamily: "var(--display)",
          fontSize: "1.8rem",
          color: "var(--orange)",
          letterSpacing: "0.05em",
          lineHeight: 1,
        }}>
          HERMES
        </span>
        <div style={{
          borderLeft: "1px solid var(--border)",
          paddingLeft: "0.75rem",
          display: "flex",
          flexDirection: "column",
          gap: "0.15rem",
        }}>
          <span style={{ fontSize: "0.48rem", color: "var(--muted)", letterSpacing: "0.2em" }}>BTC DCA</span>
          <span style={{ fontSize: "0.48rem", color: "var(--muted)", letterSpacing: "0.2em" }}>STARKNET</span>
        </div>
      </button>

      {/* BTC price */}
      <div style={{
        display: "flex", flexDirection: "column", justifyContent: "center",
        padding: "0 1.4rem",
        borderRight: "1px solid var(--border)",
        minWidth: 160,
      }}>
        <div style={{ fontSize: "0.48rem", color: "var(--muted)", letterSpacing: "0.18em", marginBottom: "0.1rem" }}>
          BTC / USD
        </div>
        <div style={{
          fontFamily: "var(--display)",
          fontSize: "1.5rem",
          color: "var(--orange)",
          letterSpacing: "0.04em",
          lineHeight: 1,
          animation: "number-flip 0.3s ease",
        }}>
          {btcPrice ? `$${(btcPrice / 1e8).toLocaleString(undefined, { maximumFractionDigits: 0 })}` : "—"}
        </div>
      </div>

      {/* Clock */}
      <div style={{
        display: "flex", flexDirection: "column", justifyContent: "center",
        padding: "0 1.4rem",
        borderRight: "1px solid var(--border)",
      }}>
        <div style={{ fontSize: "0.48rem", color: "var(--muted)", letterSpacing: "0.18em", marginBottom: "0.1rem" }}>
          UTC
        </div>
        <div style={{ fontSize: "0.82rem", color: "var(--text)", letterSpacing: "0.1em" }}>
          {time.toUTCString().slice(17, 25)}
        </div>
      </div>

      <div style={{ flex: 1 }} />

      {/* Nav: Launch App */}
      {!isApp && (
        <button
          onClick={() => navigate("/app")}
          style={{
            background: "transparent",
            color: "var(--orange)",
            border: "none",
            borderLeft: "1px solid var(--border)",
            padding: "0 1.4rem",
            fontSize: "0.65rem",
            letterSpacing: "0.12em",
            textTransform: "uppercase",
            cursor: "pointer",
            transition: "background 0.15s",
            fontFamily: "var(--mono)",
          }}
        >
          Launch App →
        </button>
      )}

      {/* Wallet indicator */}
      <div style={{
        display: "flex", alignItems: "center", gap: "0.6rem",
        padding: "0 1.4rem",
        borderLeft: "1px solid var(--border)",
      }}>
        <span style={{
          width: 6, height: 6, borderRadius: "50%",
          background: address ? "var(--green)" : "var(--muted)",
          boxShadow: address ? "0 0 6px var(--green)" : "none",
          display: "block",
        }} />
        <span style={{
          fontSize: "0.62rem",
          color: address ? "var(--text2)" : "var(--muted)",
          letterSpacing: "0.08em",
        }}>
          {address ? shortenAddr(address) : "DISCONNECTED"}
        </span>
      </div>
    </header>
  );
}
