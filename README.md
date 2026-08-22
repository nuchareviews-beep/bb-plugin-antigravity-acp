# bb-plugin-antigravity-acp

Bridges BB to the local [Antigravity](https://antigravity.google/) CLI (`agy`) and registers it as a BB agent provider.

## What it does

- Adds **Antigravity** to the BB provider picker. Threads on this provider shell out to `agy -p ... --output-format json` once per turn, using `--conversation` for best-effort session continuity across turns in the same thread.
- Writes one JSONL line per turn to `~/.antigravity-acp/usage.jsonl` in the same `kind: "generation"` / `fact` shape [bb-plugin-usage](https://github.com/MayankBansal12/bb-plugin-usage) already reads for FX, so token counts and provider attribution flow into the usage dashboard once that plugin picks up Antigravity as a source ([PR #21](https://github.com/MayankBansal12/bb-plugin-usage/pull/21)).

## Requirements

- The Antigravity CLI on `PATH` as `agy` (install: `curl -fsSL https://antigravity.google/cli/install.sh | bash`).
- An authenticated `agy` session (`agy` handles its own OAuth on first run).

## Install

```sh
bb plugin install git:https://github.com/nuchareviews-beep/bb-plugin-antigravity-acp.git@^0.1.0
```

## Settings

- `agyBin` (default `agy`) — path to the Antigravity CLI binary
- `model` (default empty) — model override; empty means agy's own default
- `effort` (default `medium`) — reasoning effort: `low`, `medium`, or `high`

## Scope and limitations

- Single-shot, non-streaming turns (one `agy -p` invocation per `turn/start`, no mid-turn tool calls, no steer).
- Thread → agy conversation-id mapping is **in-memory only**. If the bridge process is recycled (idle eviction, reload, crash) that mapping is lost, and the next turn on a previously-resumed thread starts a fresh agy conversation rather than truly continuing the old one.

## Related

- [bb-plugin-omniroute-acp](https://github.com/nuchareviews-beep/bb-plugin-omniroute-acp) — sibling plugin bridging BB to a local OmniRoute instance.

## License

[MIT](LICENSE)
