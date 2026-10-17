#!/usr/bin/env bash
# Starts services/agent for a browser created on the `fake` executor in local `wrangler dev`, so the
# real agent ↔ gateway ↔ engine path can be exercised without a cloud VM.
#
#   scripts/dev-agent.sh <instance id>
#
# Needs AGENT_MODE=gateway for the engine (apps/engine/.dev.vars) and the gateway Worker running
# (pnpm --filter @cloudbrowser/gateway dev). The fake VM's "user data" is read from local D1, and
# the agent reports the instance's fake IP as what Chrome sees (no Chrome or neko locally).
set -euo pipefail
cd "$(dirname "$0")/.."
INSTANCE="${1:?usage: scripts/dev-agent.sh <instance id> [extra agent flags, e.g. --neko-ws ws://127.0.0.1:8099/api/ws]}"
shift
STATE=.wrangler/state
d1() { (cd apps/api && pnpm exec wrangler d1 execute cloudbrowser --local --persist-to "../../$STATE" --json --command "$1"); }

USER_DATA=$(d1 "SELECT json_extract(attrs, '\$.userData') AS u FROM fake_provider_resources WHERE kind = 'vm' AND json_extract(attrs, '\$.userData.instanceId') = '$INSTANCE'" \
  | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{const r=JSON.parse(s)[0].results[0];if(!r)process.exit(1);console.log(r.u)})')
IP=$(d1 "SELECT ip_address AS ip FROM placements WHERE instance_id = '$INSTANCE' AND status = 'current'" \
  | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>console.log(JSON.parse(s)[0].results[0].ip))')

DIR="$STATE/agents/$INSTANCE"
mkdir -p "$DIR"
echo "$USER_DATA" > "$DIR/user-data.json"
echo "agent for $INSTANCE, fake egress IP $IP" >&2
# Build, then exec the binary itself, so stopping this script stops the agent (go run would leave
# its child running).
go build -o "$DIR/agent" ./services/agent/cmd/agent
exec "$DIR/agent" \
  --user-data "$DIR/user-data.json" --state-dir "$DIR" \
  --fake-egress-ip "$IP" --expected-ip "$IP" --nft-dir "" \
  --echo "http://localhost:8787/api/echo/ip" "$@"
