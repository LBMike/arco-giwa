#!/bin/bash
set -euo pipefail
giwa_source='/private/tmp/arco-giwa-public-deploy-007'
git -C "$giwa_source" diff --exit-code fd1bdd0173315ddb6a9dfd9396d313ee63384192 -- packages/contracts/scripts/hidden-prompt.ts packages/contracts/scripts/keystore-constants.ts packages/contracts/scripts/stocks/local-keystore.ts >/dev/null
cd "$giwa_source/packages/contracts"
exec node node_modules/ts-node/dist/bin.js --project tsconfig.json ../../docs/operations/check-keystore-password.cts
