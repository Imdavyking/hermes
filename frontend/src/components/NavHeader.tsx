import { Link, useLocation } from "react-router-dom";
import { useState, useRef, useEffect } from "react";
import { Menu, X, ChevronDown } from "lucide-react";
import ConnectWalletButton from "./ConnectWalletButton";

type NavLink = {
  to: string;
  label: string;
};

const mainLinks: NavLink[] = [];
const adminLinks: NavLink[] = [];

const NavHeader = () => {
  const [menuOpen, setMenuOpen] = useState(false);
  const [adminDropdown, setAdminDropdown] = useState(false);
  const dropdownRef = useRef<HTMLDivElement>(null);
  const location = useLocation();

  // Close dropdown on outside click
  useEffect(() => {
    const handler = (e: MouseEvent) => {
      if (
        dropdownRef.current &&
        !dropdownRef.current.contains(e.target as Node)
      ) {
        setAdminDropdown(false);
      }
    };
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, []);

  // Close mobile menu on route change
  useEffect(() => {
    setMenuOpen(false);
    setAdminDropdown(false);
  }, [location.pathname]);

  const renderLinks = (links: NavLink[], isMobile = false) =>
    links.map(({ to, label }) => (
      <Link
        key={to}
        to={to}
        onClick={isMobile ? () => setMenuOpen(false) : undefined}
        style={{
          color: location.pathname === to ? "#ffc800" : "#888",
          fontSize: isMobile ? "1rem" : "0.8rem",
          letterSpacing: "0.08em",
          textDecoration: "none",
          textTransform: "uppercase",
          fontFamily: "'DM Mono', monospace",
          transition: "color 0.2s",
          padding: isMobile ? "0.5rem 0" : "0",
        }}
        onMouseEnter={(e) =>
          ((e.target as HTMLElement).style.color = "#ffc800")
        }
        onMouseLeave={(e) =>
          ((e.target as HTMLElement).style.color =
            location.pathname === to ? "#ffc800" : "#888")
        }
      >
        {label}
      </Link>
    ));

  return (
    <>
      <style>{`
        @import url('https://fonts.googleapis.com/css2?family=DM+Mono:wght@400;500;700&display=swap');
      `}</style>

      <header
        style={{
          position: "sticky",
          top: 0,
          zIndex: 100,
          background: "rgba(10,10,15,0.9)",
          backdropFilter: "blur(12px)",
          WebkitBackdropFilter: "blur(12px)",
          borderBottom: "1px solid #1a1a28",
          padding: "0 1.5rem",
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          height: 60,
          fontFamily: "'DM Mono', monospace",
        }}
      >
        {/* Logo */}
        <Link to="/" style={{ textDecoration: "none" }}>
          <div style={{ display: "flex", alignItems: "center", gap: "0.5rem" }}>
            {/* Hex icon */}
            <svg width="22" height="22" viewBox="0 0 22 22" fill="none">
              <polygon
                points="11,1 20,6 20,16 11,21 2,16 2,6"
                fill="none"
                stroke="#ffc800"
                strokeWidth="1.5"
              />
              <polygon
                points="11,5 17,8.5 17,15.5 11,19 5,15.5 5,8.5"
                fill="rgba(255,200,0,0.12)"
                stroke="none"
              />
            </svg>
            <span
              style={{
                fontSize: "1.1rem",
                fontWeight: 900,
                letterSpacing: "-0.03em",
                color: "#fff",
              }}
            >
              UM<span style={{ color: "#ffc800" }}>BRA</span>
            </span>
          </div>
        </Link>

        {/* Desktop Nav */}
        <nav
          style={{
            display: "flex",
            alignItems: "center",
            gap: "2rem",
          }}
          className="desktop-nav"
        >
          {renderLinks(mainLinks)}

          <ConnectWalletButton />
        </nav>

        {/* Mobile toggle */}
        <button
          onClick={() => setMenuOpen((v) => !v)}
          style={{
            display: "none",
            background: "none",
            border: "none",
            cursor: "pointer",
            color: "#888",
            padding: "0.25rem",
          }}
          className="mobile-toggle"
          aria-label="Toggle menu"
        >
          {menuOpen ? <X size={20} color="#ffc800" /> : <Menu size={20} />}
        </button>
      </header>

      {/* Mobile drawer */}
      {menuOpen && (
        <div
          style={{
            position: "fixed",
            top: 60,
            left: 0,
            right: 0,
            background: "#111118",
            borderBottom: "1px solid #1a1a28",
            padding: "1.5rem",
            display: "flex",
            flexDirection: "column",
            gap: "0.25rem",
            zIndex: 99,
            boxShadow: "0 16px 40px rgba(0,0,0,0.5)",
          }}
          className="mobile-menu"
        >
          {[...mainLinks, ...adminLinks].map(({ to, label }) => (
            <Link
              key={to}
              to={to}
              onClick={() => setMenuOpen(false)}
              style={{
                color: location.pathname === to ? "#ffc800" : "#888",
                fontSize: "0.9rem",
                letterSpacing: "0.1em",
                textDecoration: "none",
                textTransform: "uppercase",
                fontFamily: "'DM Mono', monospace",
                padding: "0.85rem 0.75rem",
                borderRadius: "6px",
                borderBottom: "1px solid #1a1a28",
                transition: "color 0.2s",
              }}
            >
              {label}
            </Link>
          ))}
          <div style={{ paddingTop: "1rem" }}>
            <ConnectWalletButton />
          </div>
        </div>
      )}

      {/* Responsive styles */}
      <style>{`
        @media (max-width: 768px) {
          .desktop-nav { display: none !important; }
          .mobile-toggle { display: flex !important; }
        }
      `}</style>
    </>
  );
};

export default NavHeader;
