import React, { useState } from "react";
import { RiExchangeLine, RiAddCircleLine, RiSettings4Line } from "react-icons/ri";
import PostOrderPanel from "./post-order-panel";
import FillOrderPanel from "./fill-order-panel";
import ManageOrdersPanel from "./manage-orders-panel";

type SwapSubTab = "post" | "fill" | "manage";

export default function SwapTab() {
  const [subTab, setSubTab] = useState<SwapSubTab>("fill");

  const SUB_TABS: { key: SwapSubTab; label: string; icon: React.ReactNode; desc: string }[] = [
    { key: "post", label: "Post Order", icon: <RiAddCircleLine size={14} />, desc: "Alice · sell wBTC" },
    { key: "fill", label: "Fill Order", icon: <RiExchangeLine size={14} />, desc: "Bob · buy wBTC" },
    { key: "manage", label: "Manage", icon: <RiSettings4Line size={14} />, desc: "Claim · Refund" },
  ];

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: "1rem" }}>
      {/* Flow diagram */}
      <div style={flowDiagram}>
        <FlowStep label="Alice posts" sub="locks wBTC via ZK" />
        <Chevron />
        <FlowStep label="Bob fills" sub="locks STRK" />
        <Chevron />
        <FlowStep label="Alice claims" sub="reveals secret → STRK" />
        <Chevron />
        <FlowStep label="Bob claims" sub="secret public → wBTC" />
      </div>

      {/* Sub-tab nav */}
      <div style={{
        display: "grid", gridTemplateColumns: "1fr 1fr 1fr",
        background: "#111118", border: "1px solid #1e1e2e",
        borderRadius: 10, padding: 4, gap: 4,
      }}>
        {SUB_TABS.map(({ key, label, icon, desc }) => (
          <button key={key} onClick={() => setSubTab(key)} style={{
            background: subTab === key ? "#1e1e2e" : "transparent",
            color: subTab === key ? "#ffc800" : "#3a3a4a",
            border: subTab === key ? "1px solid #2a2a3a" : "1px solid transparent",
            borderRadius: 8, padding: "0.65rem 0.5rem",
            cursor: "pointer", transition: "all 0.18s",
            display: "flex", flexDirection: "column", alignItems: "center", gap: "0.2rem",
          }}>
            <span style={{ display: "flex", alignItems: "center", gap: "0.3rem", fontSize: "0.7rem", fontFamily: "'DM Mono', monospace", fontWeight: 700, letterSpacing: "0.06em" }}>
              {icon} {label}
            </span>
            <span style={{ fontSize: "0.55rem", color: subTab === key ? "#ffc80088" : "#2a2a3a", letterSpacing: "0.1em" }}>
              {desc}
            </span>
          </button>
        ))}
      </div>

      {/* Panel content */}
      {subTab === "post" && <PostOrderPanel />}
      {subTab === "fill" && <FillOrderPanel />}
      {subTab === "manage" && <ManageOrdersPanel />}
    </div>
  );
}

function FlowStep({ label, sub }: { label: string; sub: string }) {
  return (
    <div style={{ textAlign: "center", flex: 1, minWidth: 0 }}>
      <div style={{ color: "#ffc800", fontSize: "0.62rem", fontWeight: 700, letterSpacing: "0.06em", whiteSpace: "nowrap" }}>
        {label}
      </div>
      <div style={{ color: "#2a2a3a", fontSize: "0.52rem", marginTop: "0.2rem", letterSpacing: "0.06em" }}>
        {sub}
      </div>
    </div>
  );
}

function Chevron() {
  return (
    <div style={{ color: "#2a2a3a", fontSize: "0.8rem", flexShrink: 0, paddingBottom: "0.5rem" }}>›</div>
  );
}

const flowDiagram: React.CSSProperties = {
  background: "#111118", border: "1px solid #1e1e2e", borderRadius: 10,
  padding: "0.85rem 1rem",
  display: "flex", alignItems: "center", justifyContent: "space-between", gap: "0.25rem",
};
