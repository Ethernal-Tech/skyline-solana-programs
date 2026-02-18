#!/bin/bash
# test_random.sh

TESTS=(
  "bridge_request.ts"
  "bridge_transaction.ts"
  "bridge_vsu.ts"
)

# Shuffle array
SHUFFLED=($(shuf -e "${TESTS[@]}"))

echo "Running tests in random order:"
for test in "${SHUFFLED[@]}"; do
  echo "Running: $test"
  SOLANA_NETWORK=testnet \
  ANCHOR_PROVIDER_URL=https://api.testnet.solana.com \
  ANCHOR_WALLET=~/.config/solana/testnet-wallet.json \
  yarn ts-mocha \
    -p ./tsconfig.json \
    -t 1000000 \
    "tests/$test"
  
  echo "Waiting 3 seconds before next test..."
  sleep 3
done
