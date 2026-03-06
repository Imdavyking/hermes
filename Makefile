install-bun:
	curl -fsSL https://bun.sh/install | bash

install-noir:
	curl -L https://raw.githubusercontent.com/noir-lang/noirup/refs/heads/main/install | bash
	noirup --version 1.0.0-beta.16

install-barretenberg:
	curl -L https://raw.githubusercontent.com/AztecProtocol/aztec-packages/refs/heads/master/barretenberg/bbup/install | bash
	bbup --version 3.0.0-nightly.20251104

install-starknet:
	curl --proto '=https' --tlsv1.2 -sSf https://sh.starkup.dev | sh

install-scarb:
	asdf install scarb 2.14.0
	asdf global scarb 2.14.0

install-foundry:
	asdf install starknet-foundry 0.53.0
	asdf global starknet-foundry 0.53.0


install-devnet:
	asdf plugin add starknet-devnet
	asdf install starknet-devnet 0.4.2

install-garaga:
	pip install garaga==1.0.1

install-app-deps:
	cd frontend && yarn
	cd contracts && yarn
	cd indexer && yarn
	cd keeper && yarn

devnet:
	starknet-devnet --accounts=2 --seed=0 --initial-balance=100000000000000000000000

accounts-file:
	curl -s http://localhost:5050/predeployed_accounts | jq '{"alpha-sepolia": {"devnet0": {address: .[0].address, private_key: .[0].private_key, public_key: .[0].public_key, class_hash: "0xe2eb8f5672af4e6a4e8a8f1b44989685e668489b0a25437733756c5a34a1d6", deployed: true, legacy: false, salt: "0x14", type: "open_zeppelin"}}}' > ./contracts/accounts.json

build-circuit:
	cd circuit && nargo build

exec-circuit:
	cd circuit && nargo execute witness

prove-circuit:
	bb prove --scheme ultra_honk --oracle_hash keccak -b ./circuit/target/circuit.json -w ./circuit/target/witness.gz -o ./circuit/target

gen-vk:
	bb write_vk --scheme ultra_honk --oracle_hash keccak -b ./circuit/target/circuit.json -o ./circuit/target 

gen-verifier:
	cd contracts && garaga gen --system ultra_keccak_zk_honk --vk ../circuit/target/vk --project-name verifier

build-contract:
	cd contracts/verifier && scarb build
	cd contracts && scarb build

deploy-contract:
	cd contracts && yarn deploy


artifacts:
	cp ./circuit/target/circuit.json ./frontend/src/assets/circuit.json
	cp ./circuit/target/vk ./frontend/src/assets/vk.bin
	jq .abi ./contracts/target/dev/contracts_PrivateSwap.contract_class.json > ./indexer/src/abis/private_swap.abi.json
	jq .abi ./contracts/target/dev/contracts_PrivateSwap.contract_class.json > ./keeper/src/abis/private_swap.abi.json
	jq '"import { type Abi } from \"@starknet-react/core\";\n\nconst contractAbi = \(.abi | tojson) as const satisfies Abi;\n\nexport default contractAbi;"' -r ./contracts/target/dev/contracts_PrivateSwap.contract_class.json > ./frontend/src/assets/json/abi.ts

run-app:
	cd frontend && yarn dev

# ── Docker stack ─────────────────────────────────────────────────────────────

up:
	docker compose up --build

down:
	docker compose down

up-indexer:
	cd indexer && docker compose up --build

down-indexer:
	cd indexer && docker compose down

logs:
	docker compose logs -f

# ── Local dev (no Docker) ─────────────────────────────────────────────────────

run-indexer:
	cd indexer && yarn install && yarn dev

run-frontend:
	cd frontend && yarn install && yarn dev