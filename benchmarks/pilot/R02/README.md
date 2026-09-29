# R02 — conflicting forecast

**Attribution: cowork-os.** Use only the fictional offline source packet in `packet.json`.

Return two artifacts: `result.json` and `explanation.md`. The JSON object must contain exactly `period`, `metric`, `value_usd_millions`, `controlling_source_id`, and `conflict_acknowledged`. `period`, `metric`, `value_usd_millions`, and `controlling_source_id` are JSON strings (write the value as a decimal string such as `"1.5"`, not a JSON number); `conflict_acknowledged` is a JSON boolean. Read `requested_output` for the requested period, metric, and unit. Determine the controlling and superseded source from the source dates, approval language, revision precedence, and exact span text. Derive the value and source IDs from those spans; this instruction contains no answer values or source IDs.

The grader does not interpret free-form prose. To make the explanation deterministic and auditable, write exactly these three lines in this order, replacing every placeholder with a value derived from `packet.json`. Do not include extra prose or leave placeholders in the submitted artifact:

```text
Controlling forecast: period=<period from requested_output>; metric=<metric from requested_output>; value_usd_millions=<decimal string from the controlling source span>; source_id=<controlling source ID>; citations=[[<source ID>#<span ID supporting revision/date>]] [[<source ID>#<span ID supporting value>]]
Prior forecast: period=<period from requested_output>; metric=<metric from requested_output>; value_usd_millions=<decimal string from the superseded source span>; source_id=<superseded source ID>; status=superseded; citations=[[<source ID>#<span ID supporting prior value>]]
Precedence: newer_source_id=<approved newer source ID>; older_source_id=<superseded source ID>; relation=newer_supersedes_older; citations=[[<source ID>#<span ID supporting supersession>]]
```

The grader parses each claim line, checks that the JSON and controlling line agree, verifies that the prior forecast is identified as superseded, and checks revision direction. Citation spans are bound to their claim roles: current revision/date, current value, prior forecast value, and supersession. Every citation must identify an exact source and span in the packet, and each must support the role shown in the template. The distractor span cannot support any of those roles.
