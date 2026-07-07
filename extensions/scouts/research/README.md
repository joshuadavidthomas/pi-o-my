# research/

Prior-art reports feeding [DESIGN-dynamic-agents.md](../DESIGN-dynamic-agents.md). The first two were produced 2026-07-06 by detached pi workers running on the `herdr-spike` sprite (spike 4 in the design doc) — the fleet architecture dogfooding itself.

- **amp-orb.md** — Amp's Orbs (per-thread cloud sandboxes). Key steals: thread as location-independent unit, `.agents/setup`/`.agents/resume` repo-committed lifecycle hooks, snapshot-after-setup reuse, sleep/wake billing, one UI for local+remote agents. Gaps to exploit: no local→remote migration, weak completion notifications.
- **swamp-club.md** — Swamp Club (agent-authored deterministic automation). Not a sandbox provider — the orchestration/evidence layer above one; candidate `SandboxProvider` backend (design doc OQ9). Key steals: capability proxying (stateless workers hold no credentials, per-step secret resolution), enrollment-token state machine, run-tracker / audit-log / evidence-store separation.
- **agent-definition-formats.md** — frontmatter conventions across 9 harnesses + 8 pi extensions; basis for the design doc's portability-first definition format (CC core fields, filename fallback, unknown-fields-ignored, base-pool default).

## herdr-spike sprite (fleet test bed)

sprites.dev sandbox used for the remote-fleet spikes; still live with checkpoints `v0` (base) and `v1` (golden image: herdr 0.7.1 + pi + `herdr integration install pi` + repo clone + API-key auth).

- Repo: `/home/sprite/pi-o-my` · herdr session: `fleet` (headless, started via `setsid herdr --session fleet remote-client-bridge`)
- Worker auth: API-key provider `zai`, model `glm-5.2`. OAuth fails remotely (refresh rotation); fable-5 blocked on `cloudflare-ai-gateway` env (design doc OQ4).
- Pi binary needed a symlink into the nvm bin dir: `/.sprite/languages/node/nvm/versions/node/v22.20.0/bin/pi`

Runbook (all via `sprite -s herdr-spike exec --`):

```sh
# spawn (interactive pi, --approve for headless trust prompt; place in a tab, never default-split)
herdr --session fleet agent start <name> --cwd /home/sprite/pi-o-my --no-focus -- pi --approve "<task>"

# coordinate (bounded waits; confirm `working` before trusting anything)
herdr --session fleet agent wait <name> --status working --timeout 60000
herdr --session fleet agent wait <name> --status idle

# observe / steer
herdr --session fleet agent read <name> --lines 40
herdr --session fleet agent send <name> "<steering note>"   # then: pane send-keys <pane> enter
# full TUI: `sprite -s herdr-spike console` → `herdr --session fleet`

# collect: agent get → agent_session.value = session JSONL path → parse final assistant message
herdr --session fleet agent get <name>
```

Gotchas hit live (details in the design doc's spike sections): early `idle` with no session path for ~15s after spawn; `working` status while a tool call is stalled (watch JSONL mtime); bare `agent start` piles panes into the current tab.
