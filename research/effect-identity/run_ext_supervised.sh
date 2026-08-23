#!/bin/bash
cd "C:/Users/SIVAGURU R.M/OneDrive/Desktop/AI STARTUP/research/effect-identity"
for attempt in $(seq 1 10); do
  echo "=== attempt $attempt ===" >> results/ext_supervisor.log
  timeout 280 node src/experiments/scoreV2.js --pairs corpus/pairs-v2ext.jsonl \
    --out corpus/scores-v2ext-120b.jsonl --judges openai/gpt-oss-120b \
    --retry-abstentions --batch 6 >> results/ext_supervisor.log 2>&1
  remaining=$(node -e "
    const j=require('./results/partial-pairs-v2ext-openai_gpt_oss_120b.json');
    const v=Object.values(j.scores||{});
    console.log(v.filter(x=>x===null||x===undefined).length);
  " 2>/dev/null || echo 999)
  echo "remaining nulls: $remaining" >> results/ext_supervisor.log
  if [ "$remaining" -eq 0 ]; then echo "DONE" >> results/ext_supervisor.log; break; fi
done
