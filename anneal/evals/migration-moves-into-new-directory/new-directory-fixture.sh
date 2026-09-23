#!/usr/bin/env bash
set -euo pipefail

# The repository of migration-applies-approved-step: it has no src/lib yet.
bash "$(dirname "$0")/../migration-applies-approved-step/approved-step-fixture.sh"
