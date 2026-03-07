import { useState, useEffect } from "react";
import { useNavigate, useLocation } from "react-router-dom";
import ConnectWalletButton from "../ConnectWalletButton";

interface HeaderProps {
  btcPrice: number;
}

export default function Header({ btcPrice }: HeaderProps) {
  const [time, setTime] = useState(new Date());
  const [isMobile, setIsMobile] = useState(window.innerWidth < 640);
  const navigate = useNavigate();
  const location = useLocation();
  const isApp = location.pathname === "/app";

  useEffect(() => {
    const t = setInterval(() => setTime(new Date()), 1000);
    return () => clearInterval(t);
  }, []);

  useEffect(() => {
    const handleResize = () => setIsMobile(window.innerWidth < 640);
    window.addEventListener("resize", handleResize);
    return () => window.removeEventListener("resize", handleResize);
  }, []);

  return (
    <header
      style={{
        display: "flex",
        alignItems: "stretch",
        borderBottom: "1px solid var(--border)",
        background: "var(--surface)",
        position: "sticky",
        top: 0,
        zIndex: 100,
        fontFamily: "var(--mono)",
        minHeight: isMobile ? 52 : "auto",
        overflow: "hidden",
      }}
    >
      {/* Logo */}
      <button
        onClick={() => navigate("/")}
        style={{
          display: "flex",
          alignItems: "center",
          gap: "0.75rem",
          padding: isMobile ? "0.6rem 0.9rem" : "0.85rem 1.4rem",
          borderRight: "1px solid var(--border)",
          background: "transparent",
          cursor: "pointer",
          flexShrink: 0,
        }}
      >
        <span
          style={{
            fontFamily: "var(--display)",
            fontSize: isMobile ? "1.3rem" : "1.8rem",
            color: "var(--orange)",
            letterSpacing: "0.05em",
            lineHeight: 1,
          }}
        >
          HERMES
        </span>
        {!isMobile && (
          <div
            style={{
              borderLeft: "1px solid var(--border)",
              paddingLeft: "0.75rem",
              display: "flex",
              flexDirection: "column",
              gap: "0.15rem",
            }}
          >
            <span
              style={{
                fontSize: "0.48rem",
                color: "var(--muted)",
                letterSpacing: "0.2em",
              }}
            >
              BTC DCA
            </span>
            <span
              style={{
                fontSize: "0.48rem",
                color: "var(--muted)",
                letterSpacing: "0.2em",
              }}
            >
              STARKNET
            </span>
          </div>
        )}
      </button>

      {/* BTC price */}
      <div
        style={{
          display: "flex",
          flexDirection: "column",
          justifyContent: "center",
          padding: isMobile ? "0 0.75rem" : "0 1.4rem",
          borderRight: "1px solid var(--border)",
          minWidth: isMobile ? 90 : 160,
          flexShrink: 0,
        }}
      >
        {!isMobile && (
          <div
            style={{
              fontSize: "0.48rem",
              color: "var(--muted)",
              letterSpacing: "0.18em",
              marginBottom: "0.1rem",
            }}
          >
            BTC / USD
          </div>
        )}
        <div
          style={{
            fontFamily: "var(--display)",
            fontSize: isMobile ? "1.1rem" : "1.5rem",
            color: "var(--orange)",
            letterSpacing: "0.04em",
            lineHeight: 1,
          }}
        >
          {btcPrice
            ? `$${(btcPrice / 1e8).toLocaleString(undefined, { maximumFractionDigits: 0 })}`
            : "—"}
        </div>
      </div>

      {/* Clock — hidden on mobile */}
      {!isMobile && (
        <div
          style={{
            display: "flex",
            flexDirection: "column",
            justifyContent: "center",
            padding: "0 1.4rem",
            borderRight: "1px solid var(--border)",
          }}
        >
          <div
            style={{
              fontSize: "0.48rem",
              color: "var(--muted)",
              letterSpacing: "0.18em",
              marginBottom: "0.1rem",
            }}
          >
            UTC
          </div>
          <div
            style={{
              fontSize: "0.82rem",
              color: "var(--text)",
              letterSpacing: "0.1em",
            }}
          >
            {time.toUTCString().slice(17, 25)}
          </div>
        </div>
      )}

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
            padding: isMobile ? "0 0.75rem" : "0 1.4rem",
            fontSize: isMobile ? "0.58rem" : "0.65rem",
            letterSpacing: "0.1em",
            textTransform: "uppercase",
            cursor: "pointer",
            transition: "background 0.15s",
            fontFamily: "var(--mono)",
            flexShrink: 0,
            whiteSpace: "nowrap",
          }}
        >
          {isMobile ? "App →" : "Launch App →"}
        </button>
      )}

      {/* Wallet */}
      <div
        style={{
          display: "flex",
          alignItems: "center",
          borderLeft: "1px solid var(--border)",
          padding: isMobile ? "0 0.5rem" : "0 1.4rem",
          flexShrink: 0,
        }}
      >
        <ConnectWalletButton compact={isMobile} />
      </div>
    </header>
  );
}
