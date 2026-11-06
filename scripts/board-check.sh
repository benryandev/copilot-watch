#!/bin/sh
# After switching the leaderboard writer on (README, Leaderboard writer): for each board, the rows KV holds that the
# writer does not. A row posted straight to KV in the deploy window (an old copilot-watch instance, or a stale seed)
# shows here and must be re-added by hand before the writer's next change mirrors over it. Needs .secrets/race_admin_token.
set -e
cd "$(dirname "$0")/.."
tok=$(tr -d '\n' < .secrets/race_admin_token)
for key in "$@"; do
  kv=$(pnpm dlx wrangler@4 kv key get --namespace-id 22fd6ef1fa074edea7689bdaa2b5378f --remote "$key" 2>/dev/null || echo '[]')
  do=$(curl -sf -X POST -H "x-race-admin: $tok" -H 'content-type: application/json' https://copilot-world.benryan.workers.dev/board/op -d "{\"op\":\"read\",\"key\":\"$key\"}")
  KV_ROWS="$kv" DO_ROWS="$do" node -e '
    const kv = JSON.parse(process.env.KV_ROWS || "[]"), d = JSON.parse(process.env.DO_ROWS || "[]"), ids = new Set(d.map(r => r.id));
    const missing = kv.filter(r => !ids.has(r.id));
    console.log(process.argv[1], `writer ${d.length} rows, KV ${kv.length}`, missing.length ? `MISSING from the writer: ${missing.map(r => `${r.name} ${r.ms ?? r.score} (${r.id})`).join(", ")}` : "ok");
  ' "$key"
done
