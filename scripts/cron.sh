#!/bin/bash
# COROS Daily Training Review
# Usage: bash scripts/cron.sh [--weekly]
set -e

cd "$(dirname "$0")/.."

# Step 1: Fetch latest data
echo "=== Fetching Coros data ==="
node scripts/fetch.js

# Step 2: Generate analysis report
echo ""
echo "=== Training Analysis ==="
node scripts/analyze.js

# Step 3: Generate HTML report if --weekly or Sunday
DAY_OF_WEEK=$(date +%u)
if [ "$1" = "--weekly" ] || [ "$DAY_OF_WEEK" = "7" ]; then
  echo ""
  echo "=== Generating HTML report ==="
  node scripts/report.js
  echo "HTML report generated."
fi
