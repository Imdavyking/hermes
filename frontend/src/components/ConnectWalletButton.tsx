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
      className={`cursor-pointer font-semibold rounded transition-all duration-300 disabled:opacity-50
        ${compact ? "px-2 py-1 text-xs" : "px-6 py-2 text-sm"}
        ${address ? "bg-red-600 hover:bg-red-700" : "bg-blue-600 hover:bg-blue-700"}
        text-white whitespace-nowrap
      `}
    >
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
