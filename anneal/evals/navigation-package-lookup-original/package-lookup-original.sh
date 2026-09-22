#!/usr/bin/env bash
set -euo pipefail

node "$(dirname "$0")/../navigation-fixture.js" original
