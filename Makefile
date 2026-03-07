install-bun:
	curl -fsSL https://bun.sh/install | bash

install-starknet:
	curl --proto '=https' --tlsv1.2 -sSf https://sh.starkup.dev | sh

install-scarb:
	asdf install scarb 2.14.0
	asdf global scarb 2.14.0

install-app-deps:
	cd frontend && yarn
	cd contracts && yarn
	cd indexer && yarn
	cd keeper && yarn

# ── Contracts ─────────────────────────────────────────────────────────────────

build-contract:
	cd contracts && scarb build

deploy-contract:
	cd contracts && yarn deploy

artifacts:
	jq .abi ./contracts/target/dev/contracts_Hermes.contract_class.json > ./indexer/src/abis/hermes.abi.json
	jq .abi ./contracts/target/dev/contracts_Hermes.contract_class.json > ./keeper/src/abis/hermes.abi.json
	jq '"import { type Abi } from \"@starknet-react/core\";\n\nconst contractAbi = \(.abi | tojson) as const satisfies Abi;\n\nexport default contractAbi;"' -r ./contracts/target/dev/contracts_Hermes.contract_class.json > ./frontend/src/assets/json/abi.ts

# ── Docker stack ──────────────────────────────────────────────────────────────

up:
	docker compose up --build

down:
	docker compose down

logs:
	docker compose logs -f

# ── Local dev (no Docker) ─────────────────────────────────────────────────────

run-indexer:
	cd indexer && yarn install && yarn dev

run-frontend:
	cd frontend && yarn install && yarn dev