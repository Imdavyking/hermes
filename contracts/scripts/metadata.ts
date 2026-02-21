// run once: npx tsx generate-metadata.ts
function makeMetadata(isWinner: boolean) {
  const name = isWinner ? "Zygram Winner" : "Zygram Runner-Up";
  const rank = isWinner ? "Winner" : "Runner-Up";
  const gold = isWinner ? "#ffc800" : "#a0a0b0";
  const label = isWinner ? "🏆 Winner" : "🥈 Runner-Up";

  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="400" height="400">
  <rect width="400" height="400" fill="#0a0a0f"/>
  <rect x="20" y="20" width="360" height="360" fill="none" stroke="${gold}" stroke-width="1" stroke-dasharray="4 8" rx="8"/>
  <!-- Grid lines -->
  <line x1="0" y1="200" x2="400" y2="200" stroke="${gold}" stroke-width="0.3" opacity="0.15"/>
  <line x1="200" y1="0" x2="200" y2="400" stroke="${gold}" stroke-width="0.3" opacity="0.15"/>
  <!-- Centre glow -->
  <circle cx="200" cy="160" r="70" fill="${gold}" opacity="0.08"/>
  <!-- Trophy / medal -->
  <text x="200" y="185" text-anchor="middle" font-size="72" font-family="serif">${isWinner ? "🏆" : "🥈"}</text>
  <!-- Title -->
  <text x="200" y="255" text-anchor="middle" font-size="22" font-family="monospace" fill="${gold}" font-weight="bold">ZYGRAM</text>
  <text x="200" y="285" text-anchor="middle" font-size="14" font-family="monospace" fill="${gold}" opacity="0.7">${rank.toUpperCase()}</text>
  <!-- Divider -->
  <line x1="80" y1="305" x2="320" y2="305" stroke="${gold}" stroke-width="0.5" opacity="0.3"/>
  <!-- Subtitle -->
  <text x="200" y="330" text-anchor="middle" font-size="11" font-family="monospace" fill="#555">ZK Proof Verified On-Chain</text>
  <text x="200" y="350" text-anchor="middle" font-size="10" font-family="monospace" fill="#333">Starknet · UltraHonk · Garaga</text>
</svg>`;

  const svgB64 = Buffer.from(svg).toString("base64");

  const json = JSON.stringify({
    name,
    description: `${isWinner ? "First" : "Solved"} the panagram and proved it on-chain with a ZK proof.`,
    image: `data:image/svg+xml;base64,${svgB64}`,
    attributes: [
      { trait_type: "Rank", value: rank },
      { trait_type: "Proof", value: "ZK-Honk" },
      { trait_type: "Chain", value: "Starknet" },
    ],
  });

  return Buffer.from(json).toString("base64");
}

const winner = makeMetadata(true);
const runnerUp = makeMetadata(false);

console.log("Winner token URI:");
console.log(`data:application/json;base64,${winner}`);
console.log("\nRunner-up token URI:");
console.log(`data:application/json;base64,${runnerUp}`);
