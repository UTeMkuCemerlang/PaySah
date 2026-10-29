# Finalist measurement protocol

Phase 1 KPI: employee file actions baseline 2 (download and upload), target 0 on connected channels; employee active-time median target at least 30% lower on comparable cases. The submitted Preliminary PDF SHA256 recorded by the framework is `3924f58a5de4b67ae9bc818293929021bbda0a3b1e8631d7aeb30f4a1fffec43`. Verify this against the actual submitted PDF before the final report. SDG primary 8.2, supporting 8.3.

Aim for five consenting participants and six equivalent synthetic cases covering normal, high value, wrong account, duplicate, partial amount and missing bank evidence. Record whether each participant is a team member. Alternate MANUAL/PAYSAH order across participants; use equivalent different receipt references to reduce memory effects. Practice is separate from scored trials. Keep unsuccessful attempts, waiting, retries and outliers.

Record active handling time separately from total elapsed time. Start at opening the assigned case, stop at the correct final decision, recording failure if the participant cannot complete it. Record employee downloads/uploads by observation; customer uploads do not count as employee file actions. Channel events cross-check arrival, not the absence of human actions. Collect ten observed cases per channel if practical and report actual sample counts.

Use JSON observations accepted by `npm run score:finalist -- <file>`:

```json
[]
```

The empty array is an unfilled collection sheet and deliberately fails scoring. Each real observation must supply `participant` (P01 etc.), `case_id`, equivalent `pair_id`, `condition` (MANUAL/PAYSAH), tested 40-character `commit`, positive `active_seconds`/`elapsed_seconds`, observed nonnegative integer `manual_file_actions`, `correct` and `team_member` booleans. Keep timestamps, task version, retry count, expected/actual decision, channel/provider and the observer's notes alongside the records in private raw evidence. Do not publish identity mappings or contacts.

The scorer reports paired medians and reduction `(manual - PaySah) / manual * 100`, preserves negative results and flags unmatched pairs. All rows remain in raw evidence. There are no human study or observed file-action results supplied by the agent.

`npm run eval:e2e` covers local structured fixture workflows and reports false admission, wrong release, false block, counts and local request latency. Its provider is FIXTURE. It does not measure vision or employee time. RunPod/CPU image accuracy and actual channel latency require separately authorised measurements; historical 36-image diagnostics must be labelled historical. A zero error count applies only to the actual tested set.
