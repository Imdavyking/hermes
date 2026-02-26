import { ellipsify } from "../utils/ellipsify";
import { useConnect, useDisconnect, useAccount } from "@starknet-react/core";
import {
  type StarknetkitConnector,
  useStarknetkitConnectModal,
} from "starknetkit";
export default function ConnectWalletButton() {
  const { address } = useAccount();
  const { disconnect } = useDisconnect();
  const { connectAsync, connectors } = useConnect();

  const { starknetkitConnectModal } = useStarknetkitConnectModal({
    connectors: connectors as StarknetkitConnector[],
    modalTheme: "dark",
  });

  return (
    <div className="flex flex-col items-center space-y-2">
      <button
        onClick={
          address
            ? () => {
                disconnect();
              }
            : async () => {
                const { connector } = await starknetkitConnectModal();
                if (!connector) {
                  return;
                }
                await connectAsync({ connector });
              }
        }
        className={`cursor-pointer px-6 py-2 ${
          address
            ? "bg-red-600 hover:bg-red-700"
            : "bg-blue-600 hover:bg-blue-700"
        } text-white font-semibold rounded-lg transition-all duration-300 disabled:opacity-50`}
      >
        {!address
          ? "Connect Wallet"
          : address
            ? `Disconnect (${ellipsify(address)})`
            : "Connecting..."}
      </button>
    </div>
  );
}
