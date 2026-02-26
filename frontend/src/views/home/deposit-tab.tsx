import { useCallback, useEffect, useState } from "react";
import { toast } from "react-toastify";
import { useAccount, useContract, useReadContract } from "@starknet-react/core";
import { CallData, uint256 } from "starknet";
import { FaSpinner, FaBitcoin, FaDownload } from "react-icons/fa";
import { RiShieldKeyholeFill, RiEyeOffFill } from "react-icons/ri";
import { poseidon2Hash } from "@zkpassport/poseidon2";
import abi from "../../assets/json/abi";
import { CONTRACT_ADDRESS, U128_MAX, U64_MAX } from "../../utils/constants";
import {
  type DepositStep,
  NotePreview,
  StepRow,
  btnGhost,
  btnPrimary,
} from "./shared";

interface DepositTabProps {
  payoutDisplay: string;
}

export default function DepositTab({ payoutDisplay }: DepositTabProps) {
  const { address, account } = useAccount();
  const { contract } = useContract({ abi, address: CONTRACT_ADDRESS });

  const [step, setStep] = useState<DepositStep>(1);
  const [nullifier, setNullifier] = useState("");
  const [secret, setSecret] = useState("");
  const [commitment, setCommitment] = useState("");
  const [noteReady, setNoteReady] = useState(false);
  const [approveLoading, setApproveLoading] = useState(false);
  const [depositLoading, setDepositLoading] = useState(false);
  const [BTCDenomination, setBTCDenomination] = useState(0);

  const { data: wbtcDenom } = useReadContract({
    abi,
    address: CONTRACT_ADDRESS,
    functionName: "wBTC_denomination",
    args: [],
  });

  const denomDisplay = wbtcDenom
    ? `${(Number(wbtcDenom as bigint) / 1e8).toLocaleString(undefined, { maximumFractionDigits: 8 })}`
    : "—";

  const generateNote = useCallback(() => {
    const randHex = () =>
      "0x" +
      Array.from(crypto.getRandomValues(new Uint8Array(31)))
        .map((b) => b.toString(16).padStart(2, "0"))
        .join("");
    const n = randHex();
    const s = randHex();
    const c = "0x" + poseidon2Hash([BigInt(n), BigInt(s)]).toString(16);

    setNullifier(n);
    setSecret(s);
    setCommitment(c);
    setNoteReady(true);
    setStep(2);
  }, []);

  useEffect(() => {
    const getDenom = async () => {
      if (!account) return;
      if (!contract) return;
      const wBTCDenom = await contract.call("wBTC_denomination");
      setBTCDenomination(Number(wBTCDenom));
    };
    getDenom();
  }, [account, contract]);

  const downloadNote = useCallback(() => {
    const note = JSON.stringify({ nullifier, secret, commitment }, null, 2);
    const blob = new Blob([note], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `umbra-note-${Date.now()}.json`;
    a.click();
    URL.revokeObjectURL(url);
    toast.success("Note saved — keep this file safe!");
  }, [nullifier, secret, commitment]);

  const handleApprove = async () => {
    if (!account || !contract) {
      toast.error("Connect your wallet.");
      return;
    }
    setApproveLoading(true);
    try {
      const wBTCAddress = await contract.call("wBTC_address");
      console.log("wBTC address:", wBTCAddress);
      const hexAddr = "0x" + BigInt(wBTCAddress.toString()).toString(16);

      const allowanceResult = await account.callContract({
        contractAddress: hexAddr,
        entrypoint: "allowance",
        calldata: CallData.compile([address, CONTRACT_ADDRESS]),
      });

      const currentAllowance = uint256.uint256ToBN({
        low: allowanceResult[0],
        high: allowanceResult[1],
      });

      const required = BigInt(BTCDenomination);

      if (currentAllowance >= required) {
        // Already approved — skip the tx and move on
        toast.info("Allowance already sufficient, skipping approve.");
        setStep(3);
        return;
      }
      const approveTx = await account.execute([
        {
          contractAddress: wBTCAddress.toString(),
          entrypoint: "approve",
          calldata: [CONTRACT_ADDRESS, BTCDenomination, 0],
        },
      ]);
      await account.waitForTransaction(approveTx.transaction_hash);
      toast.success("wBTC approved!");
      setStep(3);
    } catch (err: any) {
      toast.error("Approve failed: " + (err?.message ?? err));
    } finally {
      setApproveLoading(false);
    }
  };

  const handleDeposit = async () => {
    if (!account || !contract || !commitment) return;
    setDepositLoading(true);
    try {
      const commitData = uint256.bnToUint256(BigInt(commitment));
      const callData = CallData.compile([commitData]);
      const gas = await account.estimateInvokeFee({
        contractAddress: CONTRACT_ADDRESS,
        entrypoint: "deposit",
        calldata: callData,
      });

      const tx = await account.execute([
        contract.populate("deposit", [commitData]),
      ]);

      await account.waitForTransaction(tx.transaction_hash);
      toast.success(`Deposited into Umbra pool 🛡️`);
      setStep(4);
    } catch (err: any) {
      const msg =
        err?.baseError?.data?.execution_error?.error ??
        err?.message ??
        String(err);
      toast.error(msg);
    } finally {
      setDepositLoading(false);
    }
  };

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: "1rem" }}>
      {/* Step progress */}
      <div
        style={{
          background: "#111118",
          border: "1px solid #1e1e2e",
          borderRadius: 10,
          padding: "1.1rem 1.25rem",
          display: "flex",
          flexDirection: "column",
          gap: "0.85rem",
        }}
      >
        <StepRow
          n={1}
          label="Generate your note (nullifier + secret)"
          done={step > 1}
          active={step === 1}
        />
        <StepRow
          n={2}
          label="Approve pool"
          done={step > 2}
          active={step === 2}
        />
        <StepRow
          n={3}
          label="Deposit into Merkle tree"
          done={step > 3}
          active={step === 3}
        />
        <StepRow
          n={4}
          label="Save note for withdrawal"
          done={step === 4}
          active={step === 4}
        />
      </div>

      {/* Step 1 — Generate note */}
      {step === 1 && (
        <div
          style={{
            background: "#111118",
            border: "1px solid #1e1e2e",
            borderRadius: 10,
            padding: "1.25rem",
          }}
        >
          <div
            style={{
              display: "flex",
              alignItems: "flex-start",
              gap: "0.75rem",
              background: "rgba(255,200,0,0.04)",
              border: "1px solid rgba(255,200,0,0.1)",
              borderRadius: 8,
              padding: "0.85rem",
              marginBottom: "1rem",
            }}
          >
            <RiEyeOffFill
              size={14}
              color="#ffc800"
              style={{ flexShrink: 0, marginTop: 1 }}
            />
            <p
              style={{
                color: "#555",
                fontSize: "0.68rem",
                lineHeight: 1.75,
                margin: 0,
              }}
            >
              Your <span style={{ color: "#ffc800" }}>nullifier</span> and{" "}
              <span style={{ color: "#ffc800" }}>secret</span> are generated
              locally and never leave your browser. The commitment hash is what
              goes on-chain.
            </p>
          </div>
          <button
            onClick={generateNote}
            disabled={!address}
            style={btnPrimary(!!address)}
          >
            Generate Note
          </button>
          {!address && (
            <p
              style={{
                color: "#f59e0b",
                fontSize: "0.65rem",
                textAlign: "center",
                marginTop: "0.5rem",
              }}
            >
              Connect wallet first
            </p>
          )}
        </div>
      )}

      {/* Step 2 — Approve */}
      {step === 2 && noteReady && (
        <div
          style={{
            background: "#111118",
            border: "1px solid #1e1e2e",
            borderRadius: 10,
            padding: "1.25rem",
            display: "flex",
            flexDirection: "column",
            gap: "0.85rem",
          }}
        >
          <NotePreview
            nullifier={nullifier}
            secret={secret}
            commitment={commitment}
          />
          <button onClick={downloadNote} style={btnGhost}>
            <FaDownload size={11} />
            Save umbra-note.json — required to withdraw
          </button>
          <button
            onClick={handleApprove}
            disabled={approveLoading}
            style={btnPrimary(!approveLoading)}
          >
            {approveLoading ? (
              <>
                <FaSpinner
                  size={13}
                  style={{ animation: "spin 1s linear infinite" }}
                />
                Approving…
              </>
            ) : (
              <>
                <FaBitcoin size={13} />
                Approve {BTCDenomination / 10 ** 8} wBTC
              </>
            )}
          </button>
        </div>
      )}

      {/* Step 3 — Deposit */}
      {step === 3 && (
        <div
          style={{
            background: "#111118",
            border: "1px solid #1e1e2e",
            borderRadius: 10,
            padding: "1.25rem",
            display: "flex",
            flexDirection: "column",
            gap: "0.85rem",
          }}
        >
          <div
            style={{
              background: "#0a0a0f",
              border: "1px solid #1e1e2e",
              borderRadius: 8,
              padding: "0.85rem",
              display: "flex",
              justifyContent: "space-between",
              alignItems: "center",
            }}
          >
            <div>
              <div
                style={{
                  color: "#2a2a3a",
                  fontSize: "0.6rem",
                  letterSpacing: "0.12em",
                  textTransform: "uppercase",
                  marginBottom: "0.25rem",
                }}
              >
                You send
              </div>
              <div style={{ color: "#fff", fontSize: "1rem", fontWeight: 700 }}>
                {denomDisplay} wBTC
              </div>
            </div>
            <div style={{ textAlign: "right" }}>
              <div
                style={{
                  color: "#2a2a3a",
                  fontSize: "0.6rem",
                  letterSpacing: "0.12em",
                  textTransform: "uppercase",
                  marginBottom: "0.25rem",
                }}
              >
                You receive
              </div>
              <div
                style={{ color: "#ffc800", fontSize: "1rem", fontWeight: 700 }}
              >
                {payoutDisplay}
              </div>
            </div>
          </div>
          <button
            onClick={handleDeposit}
            disabled={depositLoading}
            style={btnPrimary(!depositLoading)}
          >
            {depositLoading ? (
              <>
                <FaSpinner
                  size={13}
                  style={{ animation: "spin 1s linear infinite" }}
                />
                Depositing…
              </>
            ) : (
              <>
                <RiShieldKeyholeFill size={14} />
                Deposit into Pool
              </>
            )}
          </button>
          <p
            style={{
              color: "#2a2a3a",
              fontSize: "0.65rem",
              textAlign: "center",
              margin: 0,
              letterSpacing: "0.06em",
            }}
          >
            Your commitment is inserted into the Merkle tree · no link to your
            address
          </p>
        </div>
      )}

      {/* Step 4 — Done */}
      {step === 4 && (
        <div
          style={{
            background: "rgba(255,200,0,0.04)",
            border: "1px solid rgba(255,200,0,0.18)",
            borderRadius: 10,
            padding: "2rem 1.5rem",
            textAlign: "center",
          }}
        >
          <RiShieldKeyholeFill
            size={30}
            color="#ffc800"
            style={{ marginBottom: "0.85rem" }}
          />
          <div
            style={{
              color: "#ffc800",
              fontWeight: 900,
              fontSize: "1rem",
              letterSpacing: "0.05em",
            }}
          >
            Deposited into Umbra
          </div>
          <div
            style={{
              color: "#555",
              fontSize: "0.72rem",
              marginTop: "0.5rem",
              lineHeight: 1.7,
            }}
          >
            Your note is your key to withdraw. Use the Withdraw tab from any
            wallet — no link will ever appear on-chain.
          </div>
          <button
            onClick={downloadNote}
            style={{
              ...btnGhost,
              marginTop: "1.25rem",
              width: "auto",
              padding: "0.6rem 1.25rem",
            }}
          >
            <FaDownload size={11} />
            Re-download note
          </button>
        </div>
      )}
    </div>
  );
}
