---
name: analyze-csv
description: "Load a CSV and provide insights"
---

# Analyze CSV

## Purpose

Load a CSV and provide insights

## Routing

- Use when: Use when asked to analyze a CSV file for schema, data quality, statistical summaries, or anomalies.
- Do not use when: Don't use this for non-tabular files or for purely visual charting without data inspection.
- Outputs: Concise dataset summary with column stats, missing-value signals, and actionable insights.
- Success criteria: Reports include row/column counts, datatype observations, numeric statistics, and high-confidence anomalies.

## Trigger Examples

### Positive

- Use the analyze-csv skill for this request.
- Help me with analyze csv.
- Use when asked to analyze a CSV file for schema, data quality, statistical summaries, or anomalies.
- Analyze CSV: provide an actionable result.

### Negative

- Don't use this for non-tabular files or for purely visual charting without data inspection.
- Do not use analyze-csv for unrelated requests.
- This request is outside analyze csv scope.
- This is conceptual discussion only; no tool workflow is needed.

## Parameters

| Name | Type | Required | Description |
|---|---|---|---|
| path | string | Yes | Path to the CSV file |

## Runtime Prompt

- Current runtime prompt length: 499 characters.
- Runtime prompt is defined directly in `../analyze-csv.json`. 
