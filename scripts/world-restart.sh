#!/bin/sh
# Reset the live room so it runs the code just deployed (a busy Durable Object keeps old code until restarted).
# Everyone connected reconnects within a second. Needs .secrets/race_admin_token (never printed).
set -e
cd "$(dirname "$0")/.."
tok=$(tr -d '\n' < .secrets/race_admin_token)
curl -sf -X POST -H "x-race-admin: $tok" https://copilot-world.benryan.workers.dev/restart >/dev/null && sleep 2
curl -s -H 'origin: https://strike.benryan.com.au' https://copilot-world.benryan.workers.dev/presence; echo
