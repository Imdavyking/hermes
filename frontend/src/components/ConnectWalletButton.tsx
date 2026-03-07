import { ellipsify } from "../utils/ellipsify";
import { useConnect, useDisconnect, useAccount } from "@starknet-react/core";
import {
  type StarknetkitConnector,
  useStarknetkitConnectModal,
} from "starknetkit";

interface ConnectWalletButtonProps {
  compact?: boolean;
}

export default function ConnectWalletButton({
  compact,
}: ConnectWalletButtonProps) {
  const { address } = useAccount();
  const { disconnect } = useDisconnect();
  const { connectAsync, connectors } = useConnect();

  const { starknetkitConnectModal } = useStarknetkitConnectModal({
    connectors: connectors as StarknetkitConnector[],
    modalTheme: "dark",
  });

  return (
    <button
      onClick={
        address
          ? () => disconnect()
          : async () => {
              const { connector } = await starknetkitConnectModal();
              if (!connector) return;
              await connectAsync({ connector });
            }
      }
      style={{
        display: "flex",
        alignItems: "center",
        gap: "0.5rem",
        background: "transparent",
        border: "1px solid var(--border)",
        color: address ? "var(--muted)" : "var(--orange)",
        fontFamily: "var(--mono)",
        fontSize: compact ? "0.6rem" : "0.65rem",
        letterSpacing: "0.1em",
        textTransform: "uppercase",
        padding: compact ? "0.35rem 0.65rem" : "0.5rem 1rem",
        cursor: "pointer",
        whiteSpace: "nowrap",
        transition: "border-color 0.15s, color 0.15s",
      }}
      onMouseEnter={(e) => {
        (e.currentTarget as HTMLButtonElement).style.borderColor =
          "var(--orange)";
        (e.currentTarget as HTMLButtonElement).style.color = address
          ? "var(--text)"
          : "var(--orange)";
      }}
      onMouseLeave={(e) => {
        (e.currentTarget as HTMLButtonElement).style.borderColor =
          "var(--border)";
        (e.currentTarget as HTMLButtonElement).style.color = address
          ? "var(--muted)"
          : "var(--orange)";
      }}
    >
      <span
        style={{
          width: 6,
          height: 6,
          borderRadius: "50%",
          background: address ? "var(--green, #22c55e)" : "var(--muted, #555)",
          boxShadow: address ? "0 0 6px var(--green, #22c55e)" : "none",
          flexShrink: 0,
          display: "block",
        }}
      />
      {!address
        ? compact
          ? "Connect"
          : "Connect Wallet"
        : compact
          ? ellipsify(address, 4)
          : `Disconnect (${ellipsify(address)})`}
    </button>
  );
}
