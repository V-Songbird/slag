#!/usr/bin/env bash
set -euo pipefail

node "$(dirname "$0")/../heldout-fixture.js" original
