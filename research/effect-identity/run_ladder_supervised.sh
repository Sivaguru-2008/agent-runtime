#!/bin/bash
# Supervisor: keep resuming scoreV2.js against the ladder until every pair has
# a non-null outcome or a bounded number of resume attempts is exhausted. Each
# resume is a fresh process, so a hang in one attempt cannot poison the next.
cd "C:/Users/SIVAGURU R.M/OneDrive/Desktop/AI STARTUP/research/effect-identity"
for attempt in $(seq 1 8); do
  echo "=== attempt $attempt ===" >> results/ladder_supervisor.log
  timeout 280 node src/experiments/scoreV2.js --pairs corpus/ladder.jsonl \
    --out corpus/scores-ladder.jsonl --judges openai/gpt-oss-120b \
    --retry-abstentions --batch 6 >> results/ladder_supervisor.log 2>&1
  remaining=$(node -e "
    const j=require('./results/partial-ladder-openai_gpt_oss_120b.json');
    const v=Object.values(j.scores||{});
    console.log(v.filter(x=>x===null||x===undefined).length);
  " 2>/dev/null || echo 999)
  echo "remaining nulls: $remaining" >> results/ladder_supervisor.log
  if [ "$remaining" -eq 0 ]; then echo "DONE" >> results/ladder_supervisor.log; break; fi
done
