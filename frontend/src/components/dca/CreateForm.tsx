import { useState } from "react";
import { toast } from "react-toastify";
import {
  useAccount,
  useContract,
  useNetwork,
  useReadContract,
} from "@starknet-react/core";
import { CallData, uint256, type Call } from "starknet";
import abi from "../../assets/json/abi";
import { CONTRACT_ADDRESS } from "../../utils/constants";
import { assertReceiptSuccess } from "../../utils/helpers";
import { connectXverse } from "../../lib/xverse";
import { BtnPrimary, BtnGhost } from "../ui/Button";
import ChipGroup from "../ui/Chip";
import { FieldLabel, SummaryRow, Divider } from "../ui/Layout";
import Spinner from "../ui/Spinner";

const ERC20_ABI = [
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

const fmtStrk = (raw: bigint | number) =>
  (Number(raw) / 1e18).toLocaleString(undefined, { maximumFractionDigits: 4 }) +
  " STRK";

const fmtHours = (h: number) => {
  if (h < 24) return `${h}h`;
  if (h % 168 === 0) return `${h / 168}w`;
  if (h % 24 === 0) return `${h / 24}d`;
  return `${h}h`;
};

const inputStyle: React.CSSProperties = {
  fontFamily: "var(--mono)",
  background: "var(--bg)",
  border: "1px solid var(--border)",
  color: "var(--text)",
  borderRadius: 3,
  padding: "0.6rem 0.85rem",
  fontSize: "0.78rem",
  outline: "none",
  width: "100%",
  transition: "border-color 0.15s",
};

interface CreateFormProps {
  keeperFee: bigint;
  btcUsd: number | null;
}

export default function CreateForm({ keeperFee }: CreateFormProps) {
  const { address, account } = useAccount();
  const { contract } = useContract({ abi, address: CONTRACT_ADDRESS });
  const { chain } = useNetwork();
  const isTestnet =
    chain?.name?.toLowerCase().includes("sepolia") ||
    chain?.name?.toLowerCase().includes("test");

  const [btcDest, setBtcDest] = useState("");
  const [connectingXverse, setConnectingXverse] = useState(false);
  const [usdc, setUsdc] = useState("");
  const [intervalHours, setIntervalHours] = useState(24);
  const [customHours, setCustomHours] = useState("");
  const [numExecs, setNumExecs] = useState(12);
  const [customExec, setCustomExec] = useState("");
  const [approving, setApproving] = useState(false);
  const [approveOk, setApproveOk] = useState(false);
  const [creating, setCreating] = useState(false);
  const [minting, setMinting] = useState(false);

  const effHours = customHours ? Number(customHours) : intervalHours;
  const effExecs = customExec ? Number(customExec) : numExecs;
  const totalStrkFee = keeperFee * BigInt(effExecs);

  // ── Token addresses ──────────────────────────────────────────────────────────
  const { data: usdcAddressRaw } = useReadContract({
    abi,
    address: CONTRACT_ADDRESS,
    functionName: "usdc_address",
    args: [],
  });
  const { data: strkAddressRaw } = useReadContract({
    abi,
    address: CONTRACT_ADDRESS,
    functionName: "strk_address",
    args: [],
  });

  const usdcAddr = usdcAddressRaw
    ? (`0x${BigInt(usdcAddressRaw.toString()).toString(16)}` as `0x${string}`)
    : undefined;
  const strkAddr = strkAddressRaw
    ? (`0x${BigInt(strkAddressRaw.toString()).toString(16)}` as `0x${string}`)
    : undefined;

  // ── Balances ─────────────────────────────────────────────────────────────────
  const { data: usdcBalanceData } = useReadContract({
    abi: ERC20_ABI,
    address: usdcAddr,
    functionName: "balance_of",
    args: address ? [address] : undefined,
    enabled: !!usdcAddr && !!address,
    watch: true,
    refetchInterval: 15_000,
  });
  const { data: strkBalanceData } = useReadContract({
    abi: ERC20_ABI,
    address: strkAddr,
    functionName: "balance_of",
    args: address ? [address] : undefined,
    enabled: !!strkAddr && !!address,
    watch: true,
    refetchInterval: 15_000,
  });

  const usdcBalance =
    usdcBalanceData != null
      ? Number(BigInt((usdcBalanceData as any).toString())) / 1e6
      : null;
  const strkBalance: bigint =
    strkBalanceData != null
      ? BigInt((strkBalanceData as any).toString())
      : BigInt(0);

  // ── BTC preview ───────────────────────────────────────────────────────────────
  const usdcRawForPreview =
    usdc && Number(usdc) > 0 ? BigInt(Math.round(Number(usdc) * 1e6)) : null;
  const { data: wbtcPreviewData } = useReadContract({
    abi,
    address: CONTRACT_ADDRESS,
    functionName: "preview_btc_for_usdc",
    args: usdcRawForPreview
      ? [uint256.bnToUint256(usdcRawForPreview)]
      : [uint256.bnToUint256(0)],
    enabled: !!usdcRawForPreview,
    watch: false,
  });
  const btcPreviewSats = wbtcPreviewData
    ? Number(BigInt((wbtcPreviewData as any).toString()))
    : null;

  // ── Derived ───────────────────────────────────────────────────────────────────
  const totalUsdc = usdc ? Number(usdc) * effExecs : null;
  const insufficientUsdc =
    totalUsdc !== null && usdcBalance !== null && totalUsdc > usdcBalance;
  const insufficientStrk = strkBalance < totalStrkFee;
  const insufficientBalance = insufficientUsdc || insufficientStrk;

  const resetApproval = () => setApproveOk(false);

  // ── Xverse ────────────────────────────────────────────────────────────────────
  const handleConnectXverse = async () => {
    setConnectingXverse(true);
    try {
      const addr = await connectXverse();
      setBtcDest(addr);
      resetApproval();
      toast.success(`Bitcoin address: ${addr.slice(0, 8)}…${addr.slice(-6)}`);
    } catch (err: any) {
      toast.error(err?.message ?? "Xverse connection failed");
    } finally {
      setConnectingXverse(false);
    }
  };

  // ── Approve ───────────────────────────────────────────────────────────────────
  const handleApprove = async () => {
    if (!account || !address) return toast.error("Connect wallet first.");
    if (!usdcAddressRaw || !strkAddr)
      return toast.error("Could not read token addresses.");
    if (!btcDest) return toast.error("Enter a Bitcoin address first.");
    if (!usdc || Number(usdc) < 1) return toast.error("Minimum 1 USDC.");
    if (insufficientUsdc)
      return toast.error(
        `Insufficient USDC — you have $${usdcBalance!.toFixed(2)}`,
      );
    if (insufficientStrk)
      return toast.error(
        `Insufficient STRK — need ${fmtStrk(totalStrkFee)}, have ${fmtStrk(strkBalance)}`,
      );

    const toastId = toast.loading("Approving USDC + STRK…");
    setApproving(true);
    try {
      const usdcAddrHex = "0x" + BigInt(usdcAddressRaw.toString()).toString(16);
      const strkAddrHex = "0x" + BigInt(strkAddr).toString(16);
      const totalUsdcRaw = BigInt(Math.round(Number(usdc) * effExecs * 1e6));
      const usdcU256 = uint256.bnToUint256(totalUsdcRaw);
      const strkU256 = uint256.bnToUint256(totalStrkFee);

      const [usdcAlw, strkAlw] = await Promise.all([
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
        low: usdcAlw[0],
        high: usdcAlw[1],
      });
      const existingStrk = uint256.uint256ToBN({
        low: strkAlw[0],
        high: strkAlw[1],
      });
      const needsUsdc = existingUsdc < totalUsdcRaw;
      const needsStrk = existingStrk < totalStrkFee;

      if (!needsUsdc && !needsStrk) {
        toast.update(toastId, {
          render: "Allowances already sufficient.",
          isLoading: false,
          type: "info",
          autoClose: 3000,
        });
        setApproveOk(true);
        return;
      }

      const calls: Call[] = [];
      if (needsUsdc)
        calls.push({
          contractAddress: usdcAddrHex,
          entrypoint: "approve",
          calldata: CallData.compile([CONTRACT_ADDRESS, usdcU256]),
        });
      if (needsStrk)
        calls.push({
          contractAddress: strkAddrHex,
          entrypoint: "approve",
          calldata: CallData.compile([CONTRACT_ADDRESS, strkU256]),
        });

      const tx = await account.execute(calls);
      await account.waitForTransaction(tx.transaction_hash);
      toast.update(toastId, {
        render: "Approved.",
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

  // ── Create ────────────────────────────────────────────────────────────────────
  const handleCreate = async () => {
    if (!account || !contract || !address)
      return toast.error("Connect wallet.");
    if (!btcDest) return toast.error("Enter a Bitcoin address.");
    if (!usdc || Number(usdc) < 1) return toast.error("Minimum 1 USDC.");
    if (effHours < 1 || effHours > 720)
      return toast.error("Interval must be 1–720 hours.");
    if (effExecs < 1 || effExecs > 1000)
      return toast.error("Executions must be 1–1000.");
    if (!approveOk) return toast.error("Complete step 1 first.");

    const toastId = toast.loading("Creating DCA order…");
    setCreating(true);
    try {
      const usdcRaw = uint256.bnToUint256(
        BigInt(Math.round(Number(usdc) * 1e6)),
      );
      const populate = contract.populate("create_dca_order", [
        btcDest,
        usdcRaw,
        effHours,
        effExecs,
      ]);
      await account.estimateInvokeFee([populate]);
      const tx = await account.execute([populate]);
      const receipt = await account.waitForTransaction(tx.transaction_hash);
      assertReceiptSuccess(receipt);
      toast.update(toastId, {
        render: `Order created — ~${btcPreviewSats?.toLocaleString() ?? "?"} sat every ${fmtHours(effHours)} × ${effExecs}`,
        isLoading: false,
        type: "success",
        autoClose: 6000,
      });
      setBtcDest("");
      setUsdc("");
      setCustomHours("");
      setCustomExec("");
      setApproveOk(false);
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

  // ── Mint test USDC ────────────────────────────────────────────────────────────
  const handleMint = async () => {
    if (!account || !address) return toast.error("Connect wallet first.");
    if (!usdcAddressRaw)
      return toast.error("Mock USDC address not configured.");
    const toastId = toast.loading("Minting test USDC…");
    setMinting(true);
    try {
      const amountRaw = BigInt(Math.round(10_000 * 1e6));
      const tx = await account.execute({
        contractAddress: "0x" + BigInt(usdcAddressRaw.toString()).toString(16),
        entrypoint: "mint",
        calldata: CallData.compile([address, uint256.bnToUint256(amountRaw)]),
      });
      await account.waitForTransaction(tx.transaction_hash);
      toast.update(toastId, {
        render: "Minted $10,000 test USDC.",
        isLoading: false,
        type: "success",
        autoClose: 4000,
      });
    } catch (err: any) {
      toast.update(toastId, {
        render: err?.message || "Mint failed",
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
    !!btcDest &&
    !!usdc &&
    Number(usdc) >= 1 &&
    !approving &&
    !insufficientBalance;
  const canCreate =
    !!address &&
    !!btcDest &&
    !!usdc &&
    Number(usdc) >= 1 &&
    approveOk &&
    !creating &&
    effHours >= 1 &&
    effHours <= 720 &&
    effExecs >= 1 &&
    effExecs <= 1000;

  return (
    <div
      style={{
        display: "flex",
        flexDirection: "column",
        gap: "1rem",
        fontFamily: "var(--mono)",
      }}
    >
      {/* Testnet mint strip */}
      {isTestnet && (
        <div
          style={{
            background: "rgba(247,147,26,0.04)",
            border: "1px solid rgba(247,147,26,0.15)",
            padding: "0.7rem 1rem",
            borderRadius: 3,
            display: "flex",
            alignItems: "center",
            justifyContent: "space-between",
            gap: "1rem",
          }}
        >
          <span
            style={{
              fontSize: "0.6rem",
              color: "var(--muted)",
              letterSpacing: "0.05em",
            }}
          >
            Sepolia testnet — mint $10,000 mock USDC to get started
          </span>
          <button
            onClick={handleMint}
            disabled={minting}
            style={{
              background: "transparent",
              color: "var(--orange)",
              border: "1px solid rgba(247,147,26,0.4)",
              padding: "0.32rem 0.85rem",
              fontSize: "0.62rem",
              letterSpacing: "0.1em",
              fontFamily: "var(--mono)",
              borderRadius: 3,
              cursor: minting ? "not-allowed" : "pointer",
              whiteSpace: "nowrap",
              display: "flex",
              alignItems: "center",
              gap: "0.4rem",
            }}
          >
            {minting ? (
              <>
                <Spinner size={10} /> Minting…
              </>
            ) : (
              "Mint Test USDC"
            )}
          </button>
        </div>
      )}

      {/* Bitcoin destination */}
      <div>
        <FieldLabel hint={btcDest ? "✓ SET" : ""}>
          Bitcoin destination address
        </FieldLabel>
        <div style={{ display: "flex", gap: "0.5rem" }}>
          <input
            value={btcDest}
            onChange={(e) => {
              setBtcDest(e.target.value);
              resetApproval();
            }}
            placeholder="tb1q… or connect Xverse"
            style={inputStyle}
          />
          <button
            onClick={handleConnectXverse}
            disabled={connectingXverse}
            style={{
              background: "transparent",
              color: "var(--orange)",
              border: "1px solid rgba(247,147,26,0.4)",
              padding: "0 0.9rem",
              fontSize: "0.65rem",
              letterSpacing: "0.08em",
              fontFamily: "var(--mono)",
              borderRadius: 3,
              whiteSpace: "nowrap",
              cursor: connectingXverse ? "not-allowed" : "pointer",
              display: "flex",
              alignItems: "center",
              gap: "0.4rem",
            }}
          >
            {connectingXverse ? <Spinner size={10} /> : "₿ Xverse"}
          </button>
        </div>
      </div>

      {/* USDC per execution */}
      <div>
        <FieldLabel
          hint={
            btcPreviewSats
              ? `≈ ${btcPreviewSats.toLocaleString()} sat / exec`
              : usdcBalance !== null
                ? `Balance: $${usdcBalance.toFixed(2)}`
                : ""
          }
        >
          USDC per execution
        </FieldLabel>
        <div style={{ position: "relative" }}>
          <input
            value={usdc}
            onChange={(e) => {
              setUsdc(e.target.value);
              resetApproval();
            }}
            placeholder="Min 1"
            type="number"
            min="1"
            style={{
              ...inputStyle,
              paddingRight: "3.5rem",
              borderColor: insufficientUsdc
                ? "rgba(255,77,109,0.5)"
                : undefined,
            }}
          />
          <span
            style={{
              position: "absolute",
              right: "0.85rem",
              top: "50%",
              transform: "translateY(-50%)",
              fontSize: "0.62rem",
              color: "var(--muted)",
              pointerEvents: "none",
            }}
          >
            USDC
          </span>
        </div>
      </div>

      {/* Interval */}
      <div>
        <FieldLabel>Interval</FieldLabel>
        <div
          style={{
            display: "flex",
            gap: "0.4rem",
            flexWrap: "wrap",
            alignItems: "center",
          }}
        >
          <ChipGroup
            options={[1, 6, 24, 168]}
            value={customHours ? Number(customHours) : intervalHours}
            onChange={(v) => {
              setIntervalHours(v);
              setCustomHours("");
              resetApproval();
            }}
            suffix="h"
          />
          <div style={{ position: "relative" }}>
            <input
              value={customHours}
              onChange={(e) => {
                setCustomHours(e.target.value);
                resetApproval();
              }}
              placeholder="Custom"
              type="number"
              min="1"
              max="720"
              style={{
                ...inputStyle,
                width: 100,
                padding: "0.32rem 2.2rem 0.32rem 0.65rem",
                fontSize: "0.7rem",
              }}
            />
            <span
              style={{
                position: "absolute",
                right: "0.5rem",
                top: "50%",
                transform: "translateY(-50%)",
                fontSize: "0.58rem",
                color: "var(--muted)",
                pointerEvents: "none",
              }}
            >
              h
            </span>
          </div>
        </div>
        <div
          style={{
            fontSize: "0.52rem",
            color: "var(--muted2)",
            marginTop: "0.35rem",
          }}
        >
          1h – 720h (max 30 days)
        </div>
      </div>

      {/* Executions */}
      <div>
        <FieldLabel>Number of executions</FieldLabel>
        <div
          style={{
            display: "flex",
            gap: "0.4rem",
            flexWrap: "wrap",
            alignItems: "center",
          }}
        >
          <ChipGroup
            options={[6, 12, 24, 52]}
            value={customExec ? Number(customExec) : numExecs}
            onChange={(v) => {
              setNumExecs(v);
              setCustomExec("");
              resetApproval();
            }}
            suffix="×"
          />
          <input
            value={customExec}
            onChange={(e) => {
              setCustomExec(e.target.value);
              resetApproval();
            }}
            placeholder="Custom"
            type="number"
            min="1"
            max="1000"
            style={{
              ...inputStyle,
              width: 90,
              padding: "0.32rem 0.65rem",
              fontSize: "0.7rem",
            }}
          />
        </div>
        <div
          style={{
            fontSize: "0.52rem",
            color: "var(--muted2)",
            marginTop: "0.35rem",
          }}
        >
          1 – 1,000
        </div>
      </div>

      {/* Summary */}
      {usdc && Number(usdc) >= 1 && (
        <div
          style={{
            background: "var(--bg)",
            border: "1px solid var(--border2)",
            padding: "0.85rem 1rem",
            borderRadius: 3,
            display: "flex",
            flexDirection: "column",
            gap: "0.38rem",
            animation: "fadeIn 0.2s ease",
          }}
        >
          {btcDest && (
            <SummaryRow
              label="BTC destination"
              value={`${btcDest.slice(0, 8)}…${btcDest.slice(-6)}`}
            />
          )}
          <SummaryRow
            label="Per execution"
            value={`$${Number(usdc).toFixed(2)} → ~${btcPreviewSats?.toLocaleString() ?? "?"} sat`}
          />
          <SummaryRow label="Interval" value={fmtHours(effHours)} />
          <SummaryRow label="Executions" value={`${effExecs}×`} />
          <SummaryRow label="Duration" value={fmtHours(effHours * effExecs)} />
          <Divider />
          <SummaryRow
            label="Total USDC deposited"
            value={totalUsdc ? `$${totalUsdc.toFixed(2)}` : "—"}
            accent
          />
          <SummaryRow
            label="Keeper fee reserve"
            value={fmtStrk(totalStrkFee)}
          />
          {insufficientUsdc && (
            <SummaryRow
              label="⚠ Insufficient USDC"
              value={`have $${usdcBalance!.toFixed(2)}`}
              warn
            />
          )}
          {insufficientStrk && (
            <SummaryRow
              label="⚠ Insufficient STRK"
              value={`have ${fmtStrk(strkBalance)}`}
              warn
            />
          )}
        </div>
      )}

      {/* Two-step actions */}
      <div
        style={{
          display: "grid",
          gridTemplateColumns: "1fr 1fr",
          gap: "0.6rem",
        }}
      >
        <BtnGhost
          onClick={handleApprove}
          disabled={!canApprove || approveOk}
          loading={approving}
        >
          {approveOk ? "1. ✓ Approved" : "1. Approve USDC + STRK"}
        </BtnGhost>
        <BtnPrimary
          onClick={handleCreate}
          disabled={!canCreate}
          loading={creating}
        >
          2. Create Order →
        </BtnPrimary>
      </div>
    </div>
  );
}
