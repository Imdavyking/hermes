import { ARGENT_WEBWALLET_URL, CHAIN_ID } from "../utils/constants";
import {
  isInArgentMobileAppBrowser,
  ArgentMobileConnector,
} from "starknetkit/argentMobile";
import {
  isInKeplrMobileAppBrowser,
  KeplrMobileConnector,
} from "starknetkit/keplrMobile";
import {
  BraavosMobileConnector,
  isInBraavosMobileAppBrowser,
} from "starknetkit/braavosMobile";
import { jsonRpcProvider } from "@starknet-react/core";
import { InjectedConnector } from "starknetkit/injected";
import { WebWalletConnector } from "starknetkit/webwallet";
import { ControllerConnector } from "starknetkit/controller";
import { getStarknet } from "@starknet-io/get-starknet-core";
import { StarknetConfig, publicProvider } from "@starknet-react/core";
import { sepolia } from "@starknet-react/chains";

const isMobileDevice = () => {
  if (typeof window === "undefined") {
    return false;
  }
  getStarknet();
  // Primary method: User Agent + Touch support check
  const userAgent = navigator.userAgent.toLowerCase();
  const isMobileUA =
    /android|webos|iphone|ipad|ipod|blackberry|windows phone/.test(userAgent);
  const hasTouchSupport =
    "ontouchstart" in window || navigator.maxTouchPoints > 0;

  // Backup method: Screen size
  const isSmallScreen = window.innerWidth <= 768;

  // Combine checks: Must match user agent AND (touch support OR small screen)
  return isMobileUA && (hasTouchSupport || isSmallScreen);
};

export const availableConnectors = () => {
  if (isInArgentMobileAppBrowser()) {
    return [
      ArgentMobileConnector.init({
        options: {
          url: typeof window !== "undefined" ? window.location.href : "",
          dappName: "Example dapp",
          chainId: CHAIN_ID,
        },
      }),
    ];
  }

  if (isInKeplrMobileAppBrowser()) {
    return [KeplrMobileConnector.init()];
  }

  if (isInBraavosMobileAppBrowser()) {
    return [BraavosMobileConnector.init({})];
  }

  return [
    new InjectedConnector({ options: { id: "argentX" } }),
    new InjectedConnector({ options: { id: "braavos" } }),
    new InjectedConnector({ options: { id: "metamask" } }),
    new ControllerConnector(),
    ArgentMobileConnector.init({
      options: {
        url: typeof window !== "undefined" ? window.location.href : "",
        dappName: "Example dapp",
        chainId: CHAIN_ID,
      },
    }),
    isMobileDevice() ? BraavosMobileConnector.init({}) : null,
    new WebWalletConnector({ url: ARGENT_WEBWALLET_URL, theme: "dark" }),
  ].filter((connector) => connector !== null);
};

const connectors = availableConnectors();

interface StarknetProviderProps {
  children: React.ReactNode;
}

export function StarknetProvider({ children }: StarknetProviderProps) {
  const providers = jsonRpcProvider({
    rpc: () => ({
      nodeUrl: import.meta.env.VITE_RPC_ENDPOINT,
    }),
  });

  return (
    <StarknetConfig
      connectors={connectors as any[]}
      chains={[sepolia]}
      provider={providers as any}
      autoConnect
    >
      {children}
    </StarknetConfig>
  );
}
