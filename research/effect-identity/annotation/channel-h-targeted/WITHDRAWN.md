# Withdrawn response files (2026-09-29)

Three response files, `responses/responses-human-{alpha,beta,gamma}.csv`, and the
results derived from them (`results/channel_h_targeted.json`,
`results/channel_h_targeted.ingest.json`) were committed on 2026-09-27
(commit `3b0c4b3`) and reported in the manuscript as a completed targeted human
follow-up. They have been **withdrawn** and removed from the manuscript, because
they could not have been produced by this packet's instrument:

- `instrument.html` fixes each pair's left/right orientation deterministically
  from the pseudonym typed at the start. For the three pseudonyms, the files'
  `orientation` column matched the instrument on 16, 16 and 10 of 33 items
  (chance level); a genuine download matches 33 of 33.
- All three files used the same five round response times (3800–5200 ms);
  genuine downloads record per-item timings.
- No downloaded response file from those annotators exists.

No human annotation result is reported in the paper. The packet itself is
unchanged and valid: `node src/experiments/channelHTargeted.js --build`
re-verifies it against `annotation/FREEZE.json`. To collect the study, follow
`README.md`: each annotator runs `instrument.html` under their own pseudonym and
returns the downloaded CSV unedited; `--analyze` then applies the
preregistered rules. The withdrawn files remain in git history for audit.
