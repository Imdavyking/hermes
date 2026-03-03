import { config } from "./config";
import { runKeeper } from "./keeper";
import { parseAtomiqCalldata } from "./starknet";

console.log("Umbra DCA Keeper starting");
console.log(`  Contract:      ${config.contractAddress}`);
console.log(`  GraphQL:       ${config.graphqlUrl}`);
console.log(`  Poll interval: ${config.pollIntervalMs / 1000}s`);
console.log(`  Max batch:     ${config.maxBatchSize} calls/tx`);
console.log("");

// Run immediately on startup, then on the configured interval.
async function tick() {

//   struct EscrowDataFull {
//     offerer: ContractAddress,
//     claimer: ContractAddress,
//     token: ContractAddress,
//     refund_handler: ContractAddress,
//     claim_handler: ContractAddress,
//     flags: u128,
//     claim_data: felt252,
//     refund_data: felt252,
//     amount: u256,
//     fee_token: ContractAddress,
//     security_deposit: u256,
//     claimer_bounty: u256,
//     success_action: Option<EscrowExecution>,
// }
  const callData = [
    "2908762375538542241150439212221171655133544783919293786682310385506510360709",
    "3338308231217789034615606725099706969614379201548713376128745883530410524479",
    "2009894490435840142178314390393166646092438090257831307886760648929397478285",
    "1490440122667877468193239835299640263137972143119688276756024427822348944359",
    "2286858571756913470399555473130689982192760331205298974969624766717417726113",
    "251699409000014721731656410073715965958",
    "528905940662031821689347694899616132842275505023523433487885059373647093741",
    "1772572588",
    "30000000000000000000",
    "0",
    "2009894490435840142178314390393166646092438090257831307886760648929397478285",
    "0",
    "0",
    "0",
    "0",
    "1",
    "2",
    "653918734755097092477629255456485781901521254858831277872755195452421374295",
    "632855086375681193637378869967137873662305351084195030613672175705451841019",
    "1772541448",
    "0",
  ];
  const data = parseAtomiqCalldata(callData);
  console.log({ data });
  // try {
  //   await runKeeper();
  // } catch (err) {
  //   // Top-level safety net — runKeeper() handles its own errors internally
  //   // but we never want an uncaught exception to kill the process.
  //   console.error("Unexpected error in keeper:", err);
  // }
}

tick();
setInterval(tick, config.pollIntervalMs);
