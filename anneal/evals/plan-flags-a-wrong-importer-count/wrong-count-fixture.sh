#!/usr/bin/env bash
set -euo pipefail

# The repository of migration-applies-approved-step: src/cart.js and src/orders/summary.js import src/utils.js.
bash "$(dirname "$0")/../migration-applies-approved-step/approved-step-fixture.sh"
