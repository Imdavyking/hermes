import { useEffect, useState } from "react";
import { Noir, type CompiledCircuit } from "@noir-lang/noir_js";
import { UltraHonkBackend } from "@aztec/bb.js";
import { getZKHonkCallData, init as initGaraga } from "garaga";
import { flattenFieldsAsArray } from "../helpers/proof";
import initNoirC from "@noir-lang/noirc_abi";
import initACVM from "@noir-lang/acvm_js";
import acvm from "@noir-lang/acvm_js/web/acvm_js_bg.wasm?url";
import noirc from "@noir-lang/noirc_abi/web/noirc_abi_wasm_bg.wasm?url";
import circuit from "../assets/circuit.json";
import vkUrl from "../assets/vk.bin?url";

export function useZkVerifier() {
  const [vk, setVk] = useState<Uint8Array | null>(null);

  /** Initialize Noir and WASM once */
  useEffect(() => {
    const initWasm = async () => {
      try {
        await Promise.all([initACVM(fetch(acvm)), initNoirC(fetch(noirc))]);

        console.log("✅ Noir initialized");
      } catch (err) {
        console.error("Failed to initialize Noir/ACVM:", err);
      }
    };

    const loadVk = async () => {
      const response = await fetch(vkUrl);
      const buffer = await response.arrayBuffer();
      setVk(new Uint8Array(buffer));
      console.log("✅ Verifying key loaded");
    };

    initWasm();
    loadVk();
  }, []);

  /** Generate proof */
  const generateProof = async (
    input: Record<string, any>,
    onLog?: (msg: string) => void,
  ) => {
    if (!vk) {
      throw new Error("Verifying key not loaded");
    }

    let noir = new Noir(circuit as CompiledCircuit);

    onLog?.("🧮 Generating witness...");
    const execResult = await noir.execute(input);

    onLog?.("🔒 Generating proof...");
    console.log("Witness:", execResult.witness);
    // Verify public inputs match
    console.log("Return value:", execResult.returnValue);

    const honk = new UltraHonkBackend((circuit as { bytecode: any }).bytecode, {
      threads: 1,
      logger: (msg) => {
        console.log("[Honk]", msg);
        onLog?.(`[Honk] ${msg}`);
      },
    });

    const proof = await honk.generateProof(execResult.witness, {
      keccakZK: true,
    });
    honk.destroy();
    onLog?.(`🧩 Preparing callData...`);
    await initGaraga();
    const callData = getZKHonkCallData(
      proof.proof,
      flattenFieldsAsArray(proof.publicInputs),
      vk,
    );

    return { proof, callData };
  };

  return { generateProof };
}
