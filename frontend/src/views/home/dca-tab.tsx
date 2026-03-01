import React, { useState } from "react";
import { toast } from "react-toastify";
import {
  useAccount,
  useContract,
  useNetwork,
  useReadContract,
} from "@starknet-react/core";
import { CallData, uint256, type Call } from "starknet";
import { FaSpinner, FaBitcoin, FaSync, FaChevronDown } from "react-icons/fa";
import { RiLoopLeftLine, RiCloseLine, RiAddLine } from "react-icons/ri";
import { useQuery } from "@apollo/client";
import abi from "../../assets/json/abi";
import { CONTRACT_ADDRESS } from "../../utils/constants";
import { btnPrimary, btnGhost, inputStyle } from "./shared";
import { assertReceiptSuccess } from "../../utils/helpers";
import {
  GET_ACTIVE_DCA_ORDERS,
  GET_DCA_EXECUTIONS,
} from "../../graphql/queries";

// ── Types ─────────────────────────────────────────────────────────────────────

interface DcaOrder {
  orderId: string;
  owner: string;
  usdcPerInterval: string; // decimal string, USDC 6-dec
  intervalSeconds: number;
  totalIntervals: number;
  totalUsdcDeposited: string;
  executedIntervals: number; // post-increment count from contract
  isActive: boolean;
  lastExecution: number; // unix ts; next due = lastExecution + intervalSeconds
  createdTxHash: string;
  lastExecutedAtBlock?: number;
}

interface DcaExecution {
  executedIntervals: number; // 1-based
  usdcSpent: string;
  wbtcReceived: string;
  keeper: string;
  executedTimestamp: number;
  executedTxHash: string;
}

// ── Formatters ────────────────────────────────────────────────────────────────

const fmtUsdc = (raw: string | number) =>
  "$" +
  (Number(raw) / 1e6).toLocaleString(undefined, {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });

const fmtSats = (raw: string) => (Number(raw) / 1e8).toFixed(8) + " wBTC";

const fmtStrk = (raw: bigint | number) =>
  (Number(raw) / 1e18).toLocaleString(undefined, {
    minimumFractionDigits: 2,
    maximumFractionDigits: 4,
  }) + " STRK";

// BTC price comes from get_btc_usd_price() which returns (u128 price, u32 decimals).
const fmtBtcPrice = (price: number, decimals: number) =>
  "$" +
  (price / Math.pow(10, decimals)).toLocaleString(undefined, {
    maximumFractionDigits: 0,
  });

const fmtInterval = (secs: number) => {
  if (secs < 3600) return `${secs / 60}m`;
  if (secs < 86400) return `${secs / 3600}h`;
  return `${Math.round(secs / 86400)}d`;
};

const fmtHours = (h: number) => {
  if (h < 24) return `${h}h`;
  if (h % 168 === 0) return `${h / 168}w`;
  if (h % 24 === 0) return `${h / 24}d`;
  return `${h}h`;
};

const fmtCountdown = (nextDueTs: number, now: number) => {
  const diff = nextDueTs - now;
  if (diff <= 0) return "Ready";
  if (diff < 3600) return `${Math.floor(diff / 60)}m`;
  if (diff < 86400)
    return `${Math.floor(diff / 3600)}h ${Math.floor((diff % 3600) / 60)}m`;
  return `${Math.floor(diff / 86400)}d`;
};

const fmtDate = (ts: number) =>
  new Date(ts * 1000).toLocaleDateString(undefined, {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });

const toHexAddr = (raw: string) =>
  "0x" + BigInt(raw).toString(16).padStart(64, "0");

const shortenAddr = (addr: string) => addr.slice(0, 8) + "…" + addr.slice(-6);

// ── Presets ───────────────────────────────────────────────────────────────────

const HOUR_PRESETS = [
  { label: "1h", hours: 1 },
  { label: "6h", hours: 6 },
  { label: "1d", hours: 24 },
  { label: "1w", hours: 168 },
];

const EXEC_PRESETS = [3, 6, 12, 24, 52];

const ERC20_BALANCE_ABI = [
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
] as const;

// ── Component ─────────────────────────────────────────────────────────────────

export default function DcaTab() {
  const { address, account } = useAccount();
  const { contract } = useContract({ abi, address: CONTRACT_ADDRESS });

  // ── Form ──────────────────────────────────────────────────────────────────
  const [usdcAmount, setUsdcAmount] = useState("");
  const [intervalHours, setIntervalHours] = useState(24);
  const [customHours, setCustomHours] = useState("");
  const [numExecs, setNumExecs] = useState(12);
  const [customExec, setCustomExec] = useState("");
  const [approving, setApproving] = useState(false);
  const [approveOk, setApproveOk] = useState(false);
  const [creating, setCreating] = useState(false);
  const [minting, setMinting] = useState(false);

  // ── List ──────────────────────────────────────────────────────────────────
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const [cancelling, setCancelling] = useState<string | null>(null);
  const [hidden, setHidden] = useState<Set<string>>(new Set());

  const myAddr = address ? toHexAddr(address) : "";

  const {
    data: ordersData,
    loading: ordersLoading,
    refetch,
  } = useQuery(GET_ACTIVE_DCA_ORDERS, {
    variables: { owner: myAddr },
    skip: !myAddr,
    fetchPolicy: "network-only",
  });

  const orders: DcaOrder[] = ((ordersData?.dcaorders ?? []) as any[])
    .filter((o: any) => !hidden.has(o.id))
    .map((o: any) => ({
      orderId: o.id,
      owner: o.owner,
      usdcPerInterval: o.usdc_per_interval,
      intervalSeconds: Number(o.interval_seconds),
      totalIntervals: Number(o.total_intervals),
      totalUsdcDeposited: o.total_usdc_deposited,
      executedIntervals: Number(o.executed_intervals),
      isActive: Boolean(o.is_active),
      lastExecution: Number(o.last_execution),
      createdTxHash: o.created_tx_hash,
      lastExecutedAtBlock: o.last_executed_at_block
        ? Number(o.last_executed_at_block)
        : undefined,
    }));

  // ── Execution history ─────────────────────────────────────────────────────
  const { data: execData, loading: execLoading } = useQuery(
    GET_DCA_EXECUTIONS,
    {
      variables: { orderId: expandedId ?? "" },
      skip: !expandedId,
      fetchPolicy: "network-only",
    },
  );
  const execHistory: DcaExecution[] = (
    (execData?.dcaexecutions ?? []) as any[]
  ).map((e: any) => ({
    executedIntervals: Number(e.executed_intervals),
    usdcSpent: e.usdc_spent,
    wbtcReceived: e.wbtc_received,
    keeper: e.keeper,
    executedTimestamp: Number(e.executed_timestamp),
    executedTxHash: e.executed_tx_hash,
  }));

  // ── Oracle price ──────────────────────────────────────────────────────────
  const { data: btcPriceData } = useReadContract({
    abi,
    address: CONTRACT_ADDRESS,
    functionName: "get_btc_usd_price",
    args: [],
    watch: true,
    refetchInterval: 30_000,
  });
  const { data: USDC_ADDRESS } = useReadContract({
    abi,
    address: CONTRACT_ADDRESS,
    functionName: "usdc_address",
    args: [],
    watch: true,
    refetchInterval: 30_000,
  });

  const { chain } = useNetwork();
  const isTestnet =
    chain?.name?.toLowerCase().includes("sepolia") ||
    chain?.name?.toLowerCase().includes("test");

  const btcPrice = btcPriceData ? Number((btcPriceData as any)[0]) : null;
  const btcDecimals = btcPriceData ? Number((btcPriceData as any)[1]) : 8;
  const btcUsd = btcPrice ? btcPrice / Math.pow(10, btcDecimals) : null;

  // ── Keeper fee — keeper_fee_strk() returns u256 (18-dec STRK) ─────────────
  // Read once on mount; this is a contract constant so no polling needed.
  const { data: keeperFeeData } = useReadContract({
    abi,
    address: CONTRACT_ADDRESS,
    functionName: "keeper_fee_strk",
    args: [],
  });
  // keeper_fee_strk returns a u256 {low, high}; extract as bigint
  const keeperFeePerExec: bigint = keeperFeeData
    ? BigInt((keeperFeeData as any).toString())
    : BigInt(500_000_000_000_000_000); // fallback: 0.5 STRK

  // ── STRK token address ────────────────────────────────────────────────────
  const { data: strkAddressRaw } = useReadContract({
    abi,
    address: CONTRACT_ADDRESS,
    functionName: "strk_address",
    args: [],
  });
  const strkAddr = strkAddressRaw
    ? (`0x${BigInt(strkAddressRaw.toString()).toString(16)}` as `0x${string}`)
    : undefined;

  // ── STRK balance ──────────────────────────────────────────────────────────
  const { data: strkBalanceData } = useReadContract({
    abi: ERC20_BALANCE_ABI,
    address: strkAddr,
    functionName: "balance_of",
    args: address ? [address] : undefined,
    enabled: !!strkAddr && !!address,
    watch: true,
    refetchInterval: 15_000,
  });
  const strkBalance: bigint =
    strkBalanceData !== undefined && strkBalanceData !== null
      ? BigInt((strkBalanceData as any).toString())
      : BigInt(0);

  // ── wBTC preview ──────────────────────────────────────────────────────────
  const usdcRawForPreview =
    usdcAmount && Number(usdcAmount) > 0
      ? BigInt(Math.round(Number(usdcAmount) * 1e6))
      : null;
  const { data: wbtcPreviewData } = useReadContract({
    abi,
    address: CONTRACT_ADDRESS,
    functionName: "preview_wbtc_for_usdc",
    args: usdcRawForPreview
      ? [uint256.bnToUint256(usdcRawForPreview)]
      : [uint256.bnToUint256(0)],
    enabled: !!usdcRawForPreview,
    watch: false,
  });
  const wbtcPreviewSats = wbtcPreviewData
    ? Number(toDecimal((wbtcPreviewData as any).toString()))
    : null;

  // ── USDC token address + balance ──────────────────────────────────────────
  const { data: usdcAddressRaw } = useReadContract({
    abi,
    address: CONTRACT_ADDRESS,
    functionName: "usdc_address",
    args: [],
  });
  const usdcAddr = usdcAddressRaw
    ? (`0x${BigInt(usdcAddressRaw.toString()).toString(16)}` as `0x${string}`)
    : undefined;

  const { data: usdcBalanceData } = useReadContract({
    abi: ERC20_BALANCE_ABI,
    address: usdcAddr,
    functionName: "balance_of",
    args: address ? [address] : undefined,
    enabled: !!usdcAddr && !!address,
    watch: true,
    refetchInterval: 15_000,
  });
  const usdcBalance =
    usdcBalanceData !== undefined && usdcBalanceData !== null
      ? Number(BigInt((usdcBalanceData as any).toString())) / 1e6
      : null;

  // ── Derived totals ────────────────────────────────────────────────────────
  const now = Math.floor(Date.now() / 1000);
  const effHours = customHours ? Number(customHours) : intervalHours;
  const effExecs = customExec ? Number(customExec) : numExecs;
  const totalUsdc = usdcAmount ? Number(usdcAmount) * effExecs : null;

  // Total STRK keeper fee the user must pre-fund
  const totalStrkFee: bigint = keeperFeePerExec * BigInt(effExecs);

  const insufficientUsdcBalance =
    totalUsdc !== null && usdcBalance !== null && totalUsdc > usdcBalance;
  const insufficientStrkBalance =
    strkAddr !== undefined && strkBalance < totalStrkFee;
  const insufficientBalance =
    insufficientUsdcBalance || insufficientStrkBalance;

  // Reset approve gate whenever anything that affects the approval amount changes
  const handleAmountChange = (v: string) => {
    setUsdcAmount(v);
    setApproveOk(false);
  };
  const handleExecChange = (n: number, custom = "") => {
    setNumExecs(n);
    setCustomExec(custom);
    setApproveOk(false);
  };

  // ── Step 1: Approve USDC + STRK in a single multicall ─────────────────────
  //
  // The contract now requires two pull transfers in create_dca_order():
  //   1. USDC: usdc_per_interval * total_intervals  (swap budget)
  //   2. STRK: KEEPER_FEE_STRK * total_intervals    (keeper fee reserve)
  //
  // We batch both approve calls into one wallet signature for UX simplicity.
  // Existing allowances are checked first — if both are already sufficient
  // we skip the tx entirely.
  const handleApprove = async () => {
    if (!account || !address) return toast.error("Connect wallet first.");
    if (!usdcAddressRaw) return toast.error("Could not read USDC address.");
    if (!strkAddr) return toast.error("Could not read STRK address.");
    if (!usdcAmount || Number(usdcAmount) < 1)
      return toast.error("Minimum 1 USDC.");
    if (insufficientUsdcBalance)
      return toast.error(
        `Insufficient USDC — you have $${usdcBalance!.toFixed(2)}`,
      );
    if (insufficientStrkBalance)
      return toast.error(
        `Insufficient STRK for keeper fee — need ${fmtStrk(totalStrkFee)}, have ${fmtStrk(strkBalance)}`,
      );

    const toastId = toast.loading("Approving USDC + STRK…");
    setApproving(true);
    try {
      const usdcAddrHex = "0x" + BigInt(usdcAddressRaw.toString()).toString(16);
      const strkAddrHex = "0x" + BigInt(strkAddr).toString(16);

      const totalUsdcRaw = BigInt(
        Math.round(Number(usdcAmount) * effExecs * 1e6),
      );
      const usdcU256 = uint256.bnToUint256(totalUsdcRaw);
      const strkU256 = uint256.bnToUint256(totalStrkFee);

      // Check existing allowances — skip approve tx if both are already sufficient
      const [usdcAlwRes, strkAlwRes] = await Promise.all([
        account.callContract({
          contractAddress: usdcAddrHex,
          entrypoint: "allowance",
          calldata: CallData.compile([address, CONTRACT_ADDRESS]),
        }),
        account.callContract({
          contractAddress: strkAddrHex,
          entrypoint: "allowance",
          calldata: CallData.compile([address, CONTRACT_ADDRESS]),
        }),
      ]);

      const existingUsdc = uint256.uint256ToBN({
        low: usdcAlwRes[0],
        high: usdcAlwRes[1],
      });
      const existingStrk = uint256.uint256ToBN({
        low: strkAlwRes[0],
        high: strkAlwRes[1],
      });

      const needsUsdcApprove = existingUsdc < totalUsdcRaw;
      const needsStrkApprove = existingStrk < totalStrkFee;

      if (!needsUsdcApprove && !needsStrkApprove) {
        toast.update(toastId, {
          render: "Allowances already sufficient.",
          isLoading: false,
          type: "info",
          autoClose: 3000,
        });
        setApproveOk(true);
        return;
      }

      // Build approve calls — only include the ones that are needed
      const calls: Call[] = [];
      if (needsUsdcApprove) {
        calls.push({
          contractAddress: usdcAddrHex,
          entrypoint: "approve",
          calldata: CallData.compile([CONTRACT_ADDRESS, usdcU256]),
        });
      }
      if (needsStrkApprove) {
        calls.push({
          contractAddress: strkAddrHex,
          entrypoint: "approve",
          calldata: CallData.compile([CONTRACT_ADDRESS, strkU256]),
        });
      }

      const tx = await account.execute(calls);
      await account.waitForTransaction(tx.transaction_hash);

      const approvedLabel = [
        needsUsdcApprove && `$${(Number(totalUsdcRaw) / 1e6).toFixed(2)} USDC`,
        needsStrkApprove && fmtStrk(totalStrkFee),
      ]
        .filter(Boolean)
        .join(" + ");

      toast.update(toastId, {
        render: `Approved ${approvedLabel}`,
        isLoading: false,
        type: "success",
        autoClose: 4000,
      });
      setApproveOk(true);
    } catch (err: any) {
      const msg =
        err?.baseError?.data?.execution_error?.error ??
        err?.message ??
        String(err);
      toast.update(toastId, {
        render: msg,
        isLoading: false,
        type: "error",
        autoClose: 5000,
      });
    } finally {
      setApproving(false);
    }
  };

  // ── Step 2: create_dca_order ───────────────────────────────────────────────
  const handleCreate = async () => {
    if (!account || !contract || !address)
      return toast.error("Connect wallet.");
    if (!usdcAmount || Number(usdcAmount) < 1)
      return toast.error("Minimum 1 USDC per execution.");
    if (effHours < 1 || effHours > 720)
      return toast.error("Interval must be 1-720 hours.");
    if (effExecs < 1 || effExecs > 1000)
      return toast.error("Executions must be 1-1000.");
    if (!approveOk) return toast.error("Complete step 1 first.");

    const toastId = toast.loading("Creating DCA order…");
    setCreating(true);
    try {
      const usdcRaw = uint256.bnToUint256(
        BigInt(Math.round(Number(usdcAmount) * 1e6)),
      );

      const populate = contract.populate("create_dca_order", [
        usdcRaw,
        effHours,
        effExecs,
      ]);

      await account.estimateInvokeFee([populate]);
      const tx = await account.execute([populate]);
      const receipt = await account.waitForTransaction(tx.transaction_hash);
      assertReceiptSuccess(receipt);

      const satsLabel = wbtcPreviewSats
        ? wbtcPreviewSats.toLocaleString() + " sat"
        : "wBTC";
      toast.update(toastId, {
        render: `DCA order created! ~${satsLabel} every ${fmtHours(effHours)} × ${effExecs}`,
        isLoading: false,
        type: "success",
        autoClose: 6000,
      });

      setUsdcAmount("");
      setCustomHours("");
      setCustomExec("");
      setApproveOk(false);
      refetch();
    } catch (err: any) {
      const msg =
        err?.baseError?.data?.execution_error?.error ??
        err?.message ??
        String(err);
      toast.update(toastId, {
        render: msg,
        isLoading: false,
        type: "error",
        autoClose: 5000,
      });
    } finally {
      setCreating(false);
    }
  };

  // ── cancel_dca ────────────────────────────────────────────────────────────
  const handleCancel = async (orderId: string) => {
    if (!account || !contract) return;
    setCancelling(orderId);
    const toastId = toast.loading("Cancelling order…");
    try {
      const populate = contract.populate("cancel_dca", [
        uint256.bnToUint256(BigInt(orderId)),
      ]);
      await account.estimateInvokeFee([populate]);
      const tx = await account.execute([populate]);
      const receipt = await account.waitForTransaction(tx.transaction_hash);
      assertReceiptSuccess(receipt);
      toast.update(toastId, {
        render: "Order cancelled. Unspent USDC + STRK fee reserve refunded.",
        isLoading: false,
        type: "success",
        autoClose: 5000,
      });
      setHidden((p) => new Set([...p, orderId]));
      if (expandedId === orderId) setExpandedId(null);
    } catch (err: any) {
      const msg =
        err?.baseError?.data?.execution_error?.error ??
        err?.message ??
        String(err);
      toast.update(toastId, {
        render: msg,
        isLoading: false,
        type: "error",
        autoClose: 5000,
      });
    } finally {
      setCancelling(null);
    }
  };

  const handleMintTestUsdc = async () => {
    if (!account || !address) return toast.error("Connect wallet first.");
    if (!USDC_ADDRESS) return toast.error("Mock USDC address not configured.");
    const mintAmount = 10_000;
    const toastId = toast.loading("Minting test USDC");
    setMinting(true);
    try {
      const amountRaw = BigInt(Math.round(mintAmount * 1e6));
      const u256Amount = uint256.bnToUint256(amountRaw);
      const tx = await account.execute({
        contractAddress: "0x" + BigInt(USDC_ADDRESS).toString(16),
        entrypoint: "mint",
        calldata: CallData.compile([address, u256Amount]),
      });
      await account.waitForTransaction(tx.transaction_hash);
      toast.update(toastId, {
        render: `Minted $${mintAmount.toLocaleString()} test USDC successfully!`,
        isLoading: false,
        type: "success",
        autoClose: 4000,
      });
    } catch (err: any) {
      const msg = err?.message || err?.toString() || "Mint failed";
      toast.update(toastId, {
        render: msg,
        isLoading: false,
        type: "error",
        autoClose: 5000,
      });
    } finally {
      setMinting(false);
    }
  };

  const canApprove =
    !!address &&
    !!usdcAmount &&
    Number(usdcAmount) >= 1 &&
    !approving &&
    !insufficientBalance;

  const canCreate =
    !!address &&
    !!usdcAmount &&
    Number(usdcAmount) >= 1 &&
    approveOk &&
    !creating &&
    effHours >= 1 &&
    effHours <= 720 &&
    effExecs >= 1 &&
    effExecs <= 1000;

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: "1rem" }}>
      {/* Banner */}
      <div style={infoBox}>
        <RiLoopLeftLine
          size={14}
          color="#ffc800"
          style={{ flexShrink: 0, marginTop: 2 }}
        />
        <div style={{ fontSize: "0.68rem", color: "#555", lineHeight: 1.8 }}>
          Schedule recurring USDC → wBTC purchases at the live oracle price.
          Full USDC is deposited upfront along with a small STRK keeper fee
          reserve. A keeper calls{" "}
          <span style={{ color: "#ffc800" }}>execute_dca</span> each interval.
          wBTC is delivered directly to your wallet every execution.
        </div>
      </div>

      {isTestnet && (
        <div style={section}>
          <div style={sectionLabel}>Testnet Tools</div>
          <div
            style={{
              fontSize: "0.68rem",
              color: "#888",
              marginBottom: "0.8rem",
            }}
          >
            Mint test USDC to fund your DCA orders (Sepolia only)
          </div>
          <div style={{ display: "flex", gap: "0.6rem", alignItems: "center" }}>
            <button
              onClick={handleMintTestUsdc}
              disabled={!isTestnet}
              style={{
                ...btnPrimary(isTestnet),
                minWidth: "120px",
                padding: "0.5rem 1rem",
              }}
            >
              {minting ? (
                <>
                  <FaSpinner
                    size={12}
                    style={{ animation: "spin 1s linear infinite" }}
                  />{" "}
                  Minting…
                </>
              ) : (
                "Mint Test USDC"
              )}
            </button>
          </div>
          <div
            style={{ fontSize: "0.62rem", color: "#555", marginTop: "0.5rem" }}
          >
            Tokens are minted directly to your wallet. Use them to approve and
            create DCA orders.
          </div>
        </div>
      )}

      {/* ── Create form ─────────────────────────────────────────────────── */}
      <div style={section}>
        <div style={sectionLabel}>New DCA order</div>

        {/* USDC per execution */}
        <div>
          <div
            style={{
              display: "flex",
              justifyContent: "space-between",
              alignItems: "baseline",
              marginBottom: "0.35rem",
            }}
          >
            <div style={fieldLabel}>USDC per execution</div>
            {usdcBalance !== null && (
              <div style={{ fontSize: "0.6rem", color: "#555" }}>
                Balance:{" "}
                <span
                  style={{
                    color: insufficientUsdcBalance ? "#f87171" : "#aaa",
                  }}
                >
                  $
                  {usdcBalance.toLocaleString(undefined, {
                    minimumFractionDigits: 2,
                    maximumFractionDigits: 2,
                  })}
                </span>
              </div>
            )}
          </div>
          <div style={{ position: "relative" }}>
            <input
              value={usdcAmount}
              onChange={(e) => handleAmountChange(e.target.value)}
              placeholder="Min 1 USDC"
              type="number"
              min="1"
              style={{
                ...inputStyle,
                paddingRight: "3.5rem",
                borderColor: insufficientUsdcBalance
                  ? "rgba(248,113,113,0.4)"
                  : undefined,
              }}
            />
            <span style={suffix}>USDC</span>
          </div>
          {wbtcPreviewSats !== null && (
            <div
              style={{
                color: "#3a3a4a",
                fontSize: "0.62rem",
                marginTop: "0.3rem",
              }}
            >
              ≈{" "}
              <span style={{ color: "#ffc800" }}>
                {wbtcPreviewSats.toLocaleString()} sat
              </span>
              {btcPrice
                ? ` at ${fmtBtcPrice(btcPrice, btcDecimals)} / BTC`
                : ""}{" "}
              (oracle)
            </div>
          )}
        </div>

        {/* Interval */}
        <div>
          <div style={fieldLabel}>Interval</div>
          <div style={{ display: "flex", gap: "0.4rem", flexWrap: "wrap" }}>
            {HOUR_PRESETS.map(({ label, hours }) => (
              <button
                key={hours}
                onClick={() => {
                  setIntervalHours(hours);
                  setCustomHours("");
                }}
                style={chip(effHours === hours && !customHours)}
              >
                {label}
              </button>
            ))}
            <div style={{ position: "relative" }}>
              <input
                value={customHours}
                onChange={(e) => setCustomHours(e.target.value)}
                placeholder="Custom"
                type="number"
                min="1"
                max="720"
                style={{
                  ...inputStyle,
                  width: 100,
                  padding: "0.4rem 2.4rem 0.4rem 0.7rem",
                  fontSize: "0.7rem",
                }}
              />
              <span style={{ ...suffix, right: "0.5rem", fontSize: "0.6rem" }}>
                h
              </span>
            </div>
          </div>
          <div
            style={{
              color: "#2a2a3a",
              fontSize: "0.6rem",
              marginTop: "0.25rem",
            }}
          >
            1–720 hours (max 30 days)
          </div>
        </div>

        {/* Number of executions */}
        <div>
          <div style={fieldLabel}>Number of executions</div>
          <div
            style={{
              display: "flex",
              gap: "0.4rem",
              flexWrap: "wrap",
              alignItems: "center",
            }}
          >
            {EXEC_PRESETS.map((n) => (
              <button
                key={n}
                onClick={() => handleExecChange(n)}
                style={chip(effExecs === n && !customExec)}
              >
                {n}×
              </button>
            ))}
            <input
              value={customExec}
              onChange={(e) => handleExecChange(numExecs, e.target.value)}
              placeholder="Custom"
              type="number"
              min="1"
              max="1000"
              style={{
                ...inputStyle,
                width: 90,
                padding: "0.4rem 0.7rem",
                fontSize: "0.7rem",
              }}
            />
          </div>
          <div
            style={{
              color: "#2a2a3a",
              fontSize: "0.6rem",
              marginTop: "0.25rem",
            }}
          >
            1–1000 executions
          </div>
        </div>

        {/* Summary */}
        {usdcAmount && Number(usdcAmount) >= 1 && (
          <div style={summaryBox}>
            <SummaryRow
              label="Per execution"
              value={`${fmtUsdc((Number(usdcAmount) * 1e6).toFixed(0))} → ~${wbtcPreviewSats?.toLocaleString() ?? "?"} sat`}
            />
            <SummaryRow label="Interval" value={fmtHours(effHours)} />
            <SummaryRow label="Executions" value={`${effExecs}×`} />
            <SummaryRow
              label="Duration"
              value={fmtHours(effHours * effExecs)}
            />
            <SummaryRow
              label="Total USDC deposited"
              value={totalUsdc ? `$${totalUsdc.toFixed(2)}` : "—"}
              highlight
            />
            {/* Keeper fee reserve — new field */}
            <SummaryRow
              label="Keeper fee reserve"
              value={fmtStrk(totalStrkFee)}
              tooltip="Pre-funded STRK paid to keepers on each execution. Refunded if you cancel."
            />
            <div
              style={{ borderTop: "1px solid #1e1e2e", margin: "0.2rem 0" }}
            />
            {/* Per-execution fee breakdown */}
            <SummaryRow
              label="Fee per execution"
              value={fmtStrk(keeperFeePerExec)}
            />

            {/* Balance warnings */}
            {insufficientUsdcBalance && (
              <div style={warningText}>
                ⚠ Insufficient USDC — you have $
                {usdcBalance!.toLocaleString(undefined, {
                  minimumFractionDigits: 2,
                  maximumFractionDigits: 2,
                })}
              </div>
            )}
            {insufficientStrkBalance && (
              <div style={warningText}>
                ⚠ Insufficient STRK for keeper fee — you have{" "}
                {fmtStrk(strkBalance)}, need {fmtStrk(totalStrkFee)}
              </div>
            )}

            <div
              style={{
                fontSize: "0.6rem",
                color: "#2a2a3a",
                marginTop: "0.3rem",
                lineHeight: 1.7,
              }}
            >
              wBTC is delivered to your wallet each execution. USDC + STRK fee
              are both pulled upfront in step 1. Unspent amounts are refunded on
              cancel.
            </div>
          </div>
        )}

        {/* Step 1 → Step 2 */}
        <div
          style={{
            display: "grid",
            gridTemplateColumns: "1fr 1fr",
            gap: "0.6rem",
          }}
        >
          <button
            onClick={handleApprove}
            disabled={!canApprove}
            style={{ ...btnPrimary(canApprove), opacity: approveOk ? 0.5 : 1 }}
          >
            {approving ? (
              <>
                <FaSpinner
                  size={12}
                  style={{ animation: "spin 1s linear infinite" }}
                />{" "}
                Approving…
              </>
            ) : approveOk ? (
              "✓ Approved"
            ) : (
              "1. Approve USDC + STRK"
            )}
          </button>
          <button
            onClick={handleCreate}
            disabled={!canCreate}
            style={btnPrimary(canCreate)}
          >
            {creating ? (
              <>
                <FaSpinner
                  size={12}
                  style={{ animation: "spin 1s linear infinite" }}
                />{" "}
                Creating…
              </>
            ) : (
              <>
                <RiAddLine size={13} /> 2. Create Order
              </>
            )}
          </button>
        </div>
      </div>

      {/* ── Active orders ────────────────────────────────────────────────── */}
      <div style={section}>
        <div
          style={{
            display: "flex",
            justifyContent: "space-between",
            alignItems: "center",
          }}
        >
          <div style={sectionLabel}>Your active orders</div>
          <button
            onClick={() => refetch()}
            disabled={ordersLoading}
            style={{
              ...btnGhost,
              width: "auto",
              padding: "0.3rem 0.7rem",
              fontSize: "0.62rem",
            }}
          >
            {ordersLoading ? (
              <FaSpinner
                size={10}
                style={{ animation: "spin 1s linear infinite" }}
              />
            ) : (
              <FaSync size={10} />
            )}
            &nbsp;Refresh
          </button>
        </div>

        {!address && (
          <div style={emptyState}>Connect wallet to see your orders</div>
        )}
        {address && ordersLoading && (
          <div
            style={{
              display: "flex",
              alignItems: "center",
              gap: "0.5rem",
              color: "#3a3a4a",
              fontSize: "0.68rem",
            }}
          >
            <FaSpinner
              size={11}
              style={{ animation: "spin 1s linear infinite" }}
            />
            Loading from indexer…
          </div>
        )}
        {address && !ordersLoading && orders.length === 0 && (
          <div style={emptyState}>No active DCA orders</div>
        )}

        {orders.map((order) => {
          const isExpanded = expandedId === order.orderId;
          const isCancelling = cancelling === order.orderId;
          const remaining = order.totalIntervals - order.executedIntervals;
          const nextDueTs = order.lastExecution + order.intervalSeconds;
          const isReady = nextDueTs <= now;
          const progress =
            (order.executedIntervals / order.totalIntervals) * 100;
          // Estimated STRK refund if cancelled now
          const strkRefundEst = keeperFeePerExec * BigInt(remaining);

          return (
            <div
              key={order.orderId}
              style={{
                border: `1px solid ${isExpanded ? "rgba(255,200,0,0.3)" : "#1e1e2e"}`,
                borderRadius: 8,
                overflow: "hidden",
                transition: "border-color 0.15s",
              }}
            >
              {/* Header */}
              <div
                onClick={() => setExpandedId(isExpanded ? null : order.orderId)}
                style={{
                  background: isExpanded ? "rgba(255,200,0,0.04)" : "#0a0a0f",
                  padding: "0.85rem 1rem",
                  display: "flex",
                  justifyContent: "space-between",
                  alignItems: "center",
                  cursor: "pointer",
                  transition: "background 0.15s",
                }}
              >
                <div
                  style={{
                    display: "flex",
                    flexDirection: "column",
                    gap: "0.2rem",
                  }}
                >
                  <div
                    style={{
                      display: "flex",
                      alignItems: "center",
                      gap: "0.5rem",
                    }}
                  >
                    <FaBitcoin size={11} color="#f7931a" />
                    <span
                      style={{
                        color: "#fff",
                        fontSize: "0.82rem",
                        fontWeight: 700,
                      }}
                    >
                      {fmtUsdc(order.usdcPerInterval)} /{" "}
                      {fmtInterval(order.intervalSeconds)}
                    </span>
                  </div>
                  <div style={{ color: "#3a3a4a", fontSize: "0.6rem" }}>
                    {order.executedIntervals}/{order.totalIntervals} done
                    {" · next: "}
                    <span style={{ color: isReady ? "#22c55e" : "#555" }}>
                      {isReady ? "now" : fmtCountdown(nextDueTs, now)}
                    </span>
                  </div>
                </div>
                <div
                  style={{
                    display: "flex",
                    alignItems: "center",
                    gap: "0.6rem",
                  }}
                >
                  <div
                    style={{
                      width: 60,
                      height: 4,
                      background: "#1e1e2e",
                      borderRadius: 2,
                      overflow: "hidden",
                    }}
                  >
                    <div
                      style={{
                        height: "100%",
                        width: `${progress}%`,
                        background: "#ffc800",
                        borderRadius: 2,
                        transition: "width 0.3s",
                      }}
                    />
                  </div>
                  <FaChevronDown
                    size={10}
                    color="#3a3a4a"
                    style={{
                      transform: isExpanded ? "rotate(180deg)" : "rotate(0deg)",
                      transition: "transform 0.2s",
                    }}
                  />
                </div>
              </div>

              {/* Expanded */}
              {isExpanded && (
                <div
                  style={{
                    padding: "0.85rem 1rem",
                    borderTop: "1px solid #1e1e2e",
                    display: "flex",
                    flexDirection: "column",
                    gap: "0.7rem",
                  }}
                >
                  <div
                    style={{
                      display: "flex",
                      flexDirection: "column",
                      gap: "0.35rem",
                    }}
                  >
                    <DetailRow
                      label="Order ID"
                      value={order.orderId.slice(0, 14) + "…"}
                    />
                    <DetailRow
                      label="wBTC recipient"
                      value={shortenAddr(order.owner)}
                    />
                    <DetailRow
                      label="Interval"
                      value={fmtInterval(order.intervalSeconds)}
                    />
                    <DetailRow
                      label="Remaining"
                      value={`${remaining} of ${order.totalIntervals}`}
                    />
                    <DetailRow
                      label="Next execution"
                      value={isReady ? "Ready for keeper" : fmtDate(nextDueTs)}
                    />
                    <DetailRow
                      label="Total deposited"
                      value={fmtUsdc(order.totalUsdcDeposited)}
                    />
                    {/* STRK fee reserve remaining */}
                    <DetailRow
                      label="STRK fee reserve left"
                      value={fmtStrk(strkRefundEst)}
                    />
                    {btcUsd && (
                      <DetailRow
                        label="≈ wBTC / exec"
                        value={
                          Math.floor(
                            (Number(order.usdcPerInterval) / 1e6 / btcUsd) *
                              1e8,
                          ).toLocaleString() + " sat (est.)"
                        }
                      />
                    )}
                  </div>

                  {/* Execution history */}
                  {execLoading && expandedId === order.orderId && (
                    <div
                      style={{
                        display: "flex",
                        alignItems: "center",
                        gap: "0.5rem",
                        color: "#3a3a4a",
                        fontSize: "0.65rem",
                      }}
                    >
                      <FaSpinner
                        size={10}
                        style={{ animation: "spin 1s linear infinite" }}
                      />
                      Loading history…
                    </div>
                  )}

                  {execHistory.length > 0 && expandedId === order.orderId && (
                    <div>
                      <div style={{ ...fieldLabel, marginBottom: "0.5rem" }}>
                        Execution history
                      </div>
                      <div
                        style={{
                          display: "flex",
                          flexDirection: "column",
                          gap: "0.3rem",
                        }}
                      >
                        {execHistory.map((e) => (
                          <div
                            key={e.executedIntervals}
                            style={{
                              background: "#0a0a0f",
                              border: "1px solid #1e1e2e",
                              borderRadius: 6,
                              padding: "0.6rem 0.8rem",
                              display: "flex",
                              justifyContent: "space-between",
                              alignItems: "center",
                            }}
                          >
                            <div>
                              <div
                                style={{
                                  color: "#aaa",
                                  fontSize: "0.7rem",
                                  fontWeight: 700,
                                }}
                              >
                                #{e.executedIntervals} —{" "}
                                {fmtSats(e.wbtcReceived)}
                              </div>
                              <div
                                style={{
                                  color: "#3a3a4a",
                                  fontSize: "0.6rem",
                                  marginTop: "0.1rem",
                                }}
                              >
                                {fmtUsdc(e.usdcSpent)} spent · keeper{" "}
                                {shortenAddr(e.keeper)}
                                {" · "}
                                <span style={{ color: "#2a2a3a" }}>
                                  fee {fmtStrk(keeperFeePerExec)}
                                </span>
                              </div>
                            </div>
                            <div
                              style={{
                                color: "#2a2a3a",
                                fontSize: "0.6rem",
                                textAlign: "right",
                              }}
                            >
                              {e.executedTimestamp
                                ? fmtDate(e.executedTimestamp)
                                : "—"}
                            </div>
                          </div>
                        ))}
                      </div>

                      {/* Avg cost basis */}
                      {execHistory.length > 1 &&
                        (() => {
                          const totalUsdcRaw = execHistory.reduce(
                            (a, e) => a + Number(e.usdcSpent),
                            0,
                          );
                          const totalSats = execHistory.reduce(
                            (a, e) => a + Number(e.wbtcReceived),
                            0,
                          );
                          const avg =
                            totalSats > 0
                              ? totalUsdcRaw / 1e6 / (totalSats / 1e8)
                              : null;
                          return avg ? (
                            <div
                              style={{
                                background: "rgba(255,200,0,0.04)",
                                border: "1px solid rgba(255,200,0,0.12)",
                                borderRadius: 6,
                                padding: "0.6rem 0.8rem",
                                fontSize: "0.65rem",
                                color: "#555",
                                marginTop: "0.25rem",
                              }}
                            >
                              Avg cost basis:{" "}
                              <span
                                style={{ color: "#ffc800", fontWeight: 700 }}
                              >
                                $
                                {avg.toLocaleString(undefined, {
                                  maximumFractionDigits: 0,
                                })}{" "}
                                / BTC
                              </span>
                            </div>
                          ) : null;
                        })()}
                    </div>
                  )}

                  {/* Cancel — note both USDC + STRK are refunded */}
                  <button
                    onClick={(e) => {
                      e.stopPropagation();
                      handleCancel(order.orderId);
                    }}
                    disabled={isCancelling}
                    style={{
                      background: "transparent",
                      color: isCancelling ? "#2a2a3a" : "#f87171",
                      border: `1px solid ${isCancelling ? "#1e1e2e" : "rgba(248,113,113,0.3)"}`,
                      borderRadius: 7,
                      padding: "0.6rem",
                      fontSize: "0.68rem",
                      fontFamily: "'DM Mono', monospace",
                      cursor: isCancelling ? "not-allowed" : "pointer",
                      display: "flex",
                      alignItems: "center",
                      justifyContent: "center",
                      gap: "0.4rem",
                      transition: "all 0.15s",
                      width: "100%",
                    }}
                  >
                    {isCancelling ? (
                      <>
                        <FaSpinner
                          size={11}
                          style={{ animation: "spin 1s linear infinite" }}
                        />{" "}
                        Cancelling…
                      </>
                    ) : (
                      <>
                        <RiCloseLine size={13} />
                        Cancel &amp; refund remaining USDC +{" "}
                        {fmtStrk(strkRefundEst)} STRK
                      </>
                    )}
                  </button>
                </div>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}

// ── Sub-components ────────────────────────────────────────────────────────────

function SummaryRow({
  label,
  value,
  highlight,
  tooltip,
}: {
  label: string;
  value: string;
  highlight?: boolean;
  tooltip?: string;
}) {
  return (
    <div
      style={{
        display: "flex",
        justifyContent: "space-between",
        alignItems: "center",
      }}
    >
      <span
        style={{
          color: "#2a2a3a",
          fontSize: "0.62rem",
          display: "flex",
          alignItems: "center",
          gap: "0.3rem",
        }}
      >
        {label}
        {tooltip && (
          <span
            title={tooltip}
            style={{
              display: "inline-flex",
              alignItems: "center",
              justifyContent: "center",
              width: 12,
              height: 12,
              borderRadius: "50%",
              border: "1px solid #2a2a3a",
              fontSize: "0.5rem",
              color: "#2a2a3a",
              cursor: "help",
            }}
          >
            ?
          </span>
        )}
      </span>
      <span
        style={{
          color: highlight ? "#ffc800" : "#555",
          fontSize: "0.62rem",
          fontFamily: "'DM Mono', monospace",
        }}
      >
        {value}
      </span>
    </div>
  );
}

function DetailRow({ label, value }: { label: string; value: string }) {
  return (
    <div style={{ display: "flex", justifyContent: "space-between" }}>
      <span style={{ color: "#3a3a4a", fontSize: "0.62rem" }}>{label}</span>
      <span
        style={{
          color: "#aaa",
          fontSize: "0.62rem",
          fontFamily: "'DM Mono', monospace",
        }}
      >
        {value}
      </span>
    </div>
  );
}

// ── Shared helpers ────────────────────────────────────────────────────────────

function toDecimal(value: string | bigint | number): string {
  return BigInt(value).toString();
}

// ── Styles ────────────────────────────────────────────────────────────────────

const section: React.CSSProperties = {
  background: "#111118",
  border: "1px solid #1e1e2e",
  borderRadius: 10,
  padding: "1.1rem 1.2rem",
  display: "flex",
  flexDirection: "column",
  gap: "0.75rem",
};
const sectionLabel: React.CSSProperties = {
  color: "#3a3a4a",
  fontSize: "0.6rem",
  letterSpacing: "0.15em",
  textTransform: "uppercase",
};
const fieldLabel: React.CSSProperties = {
  color: "#2a2a3a",
  fontSize: "0.6rem",
  letterSpacing: "0.1em",
  textTransform: "uppercase",
  marginBottom: "0.35rem",
};
const emptyState: React.CSSProperties = {
  color: "#2a2a3a",
  fontSize: "0.68rem",
  textAlign: "center",
  padding: "1rem 0",
  letterSpacing: "0.06em",
};
const infoBox: React.CSSProperties = {
  display: "flex",
  alignItems: "flex-start",
  gap: "0.75rem",
  background: "rgba(255,200,0,0.04)",
  border: "1px solid rgba(255,200,0,0.1)",
  borderRadius: 10,
  padding: "1rem",
};
const summaryBox: React.CSSProperties = {
  background: "#0a0a0f",
  border: "1px solid #1e1e2e",
  borderRadius: 8,
  padding: "0.85rem 1rem",
  display: "flex",
  flexDirection: "column",
  gap: "0.35rem",
};
const suffix: React.CSSProperties = {
  position: "absolute",
  right: "0.9rem",
  top: "50%",
  transform: "translateY(-50%)",
  color: "#3a3a4a",
  fontSize: "0.7rem",
  fontFamily: "'DM Mono', monospace",
  pointerEvents: "none",
};
const warningText: React.CSSProperties = {
  fontSize: "0.62rem",
  color: "#f87171",
  marginTop: "0.15rem",
  display: "flex",
  alignItems: "center",
  gap: "0.3rem",
};
const chip = (active: boolean): React.CSSProperties => ({
  background: active ? "#ffc800" : "transparent",
  color: active ? "#0a0a0f" : "#555",
  border: `1px solid ${active ? "#ffc800" : "#2a2a3a"}`,
  borderRadius: 6,
  padding: "0.35rem 0.7rem",
  fontSize: "0.7rem",
  fontFamily: "'DM Mono', monospace",
  fontWeight: active ? 900 : 400,
  cursor: "pointer",
  transition: "all 0.15s",
});
