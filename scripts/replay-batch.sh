#!/bin/bash
# Replay a batch of stored sessions and report which ones fail.
cd /Users/mars-sea/Development/dsh-commandcode-provider
export COMMANDCODE_API_KEY=$(python3 -c "
import yaml
d=yaml.safe_load(open('/Users/mars-sea/.dsh/.credentials.yaml'))
print(d['refs']['COMMANDCODE_API_KEY'])
")
DIR=~/.dsh/sessions/--Users-mars-sea-Development-dsh-commandcode-provider--
for f in "$@"; do
  name=$(basename $(dirname "$f"))
  out=$(REPLAY_MAX_TOKENS=1024 REPLAY_SESSION_ID="$name" REPLAY_TRACE=/tmp/replay-trace.jsonl \
    node --import tsx scripts/replay-session.mjs "$f" 2>&1)
  status=$(echo "$out" | grep -E "^outcome:" | head -1)
  hist=$(echo "$out" | grep -E "^history:" | head -1)
  echo "$name | $status | $hist"
done
