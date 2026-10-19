# CoWork's Agent Card

CoWork can describe itself with an [A2A 1.0](pact.md) agent card: what this CoWork can do and how
its tools behave, so another agent, a teammate or an admin can see that before handing it work.
CoWork already reads other agents' cards for [PACT](pact.md); this is the card it gives out.

## What the card says

- **Name, version and description.** The description says CoWork runs on its user's machine and
  does not take tasks over A2A. The card lists no A2A interface (`supportedInterfaces` is empty),
  so an A2A client will not try to send it work.
- **Skills:** the profile's enabled task skills (id, name, description, category as the tag), up to 200.
- **Tool behaviour**, in an optional extension (`urn:cowork-os:agent-card:tool-hints:v1`, marked
  `required: false`, so strict card readers accept it):
  - `builtInTools`: every built-in tool with `readOnly` and `destructive` from CoWork's tool risk
    levels, `reversible` (true for read-only tools, false for destructive ones, `null` when
    unknown), and a `costClass` (`local`, or `network` for tools that call the network).
  - `connectors`: each enabled MCP connector and its tools, with the hints the connector itself
    publishes (`readOnlyHint`, `destructiveHint`). A hint the connector does not state is `null`,
    not a guess. Connector tool calls have the cost class `external`.
  - `model`: the default model's price class: `local` (no per-token price), `metered` (with its
    USD price per million input and output tokens) or `unknown`.

## Seeing and publishing it

- `cowork agent-card` prints the card for this profile. It reads the local skills, the MCP
  settings (tools cached at each connector's last connection) and the provider settings.
- Publishing is **off by default**, because the card names the installed skills and connectors.
  `cowork agent-card publish on` sets the Control Plane setting `publishAgentCard`; the Control
  Plane (desktop app or [`coworkd`](node-daemon.md)) then answers
  `GET /.well-known/agent-card.json` with the current card (live connector tools when connected),
  `Cache-Control: max-age=300` and `Access-Control-Allow-Origin: *`. While it is off, the path
  answers 404. Only `GET` and `HEAD` are allowed.
- The Control Plane binds to `127.0.0.1` by default, so the card is only reachable from this
  machine unless you expose the Control Plane yourself (for example with Tailscale). CoWork never
  publishes it anywhere on its own.

## Estimating a task before running it

`cowork tasks plan --estimate "task prompt" [--model <id>]` gives a prepared-change-style
estimate (`kind: "summary"`, `summary`, `estimatedCost` in USD, `estimatedDurationMs`, and a
`payload` with the sample sizes and the 90th percentiles). It is based only on this profile's last
30 tasks on the model: the cost is their median total, and the duration is the median wall-clock
time of the completed ones, approval waits included. The prompt itself is not analysed. A local
model has no per-token cost; with fewer than 3 past tasks, the estimate says there is not enough
history.
