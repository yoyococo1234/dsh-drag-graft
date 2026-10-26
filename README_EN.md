# dsh-drag-graft

Drag a conversation row from the DSH sidebar onto the chat area and it lands in the composer as a **native session-reference chip** — then keep typing (or dictating) and send one message that carries both the reference and your question.

## Behaviour

1. Drag any session row from the sidebar into the conversation area and release.
2. A **chip** appears in the composer (identical to picking a conversation from the `@` menu — a Lexical decorator node, not text and not base64).
3. The caret sits after the chip; keep typing.
4. Send: one message carries the reference plus your text.

- **No persistent UI**: no drop bar, no floating panel, no buttons, no highlight animation.
- Success is silent; only failures print one line at the bottom.
- Drops inside the **sidebar** are never intercepted (official reordering and cross-workspace movers keep working).
- File drags are never intercepted (host upload behaviour is untouched).
- If the chip cannot be inserted, the plugin **falls back** to sending a reference-only message; the composer stays clean, so nothing is left behind.

## How it works (internal APIs — may break on upgrade)

The DSH composer is a **Lexical** editor: direct DOM writes, `execCommand` and synthetic `paste` never reach its state, so "type `@` programmatically" is a dead end (measured: text lands in the DOM, the trigger menu never opens).

Only the official launcher pipeline works:

| Step | API | Note |
|---|---|---|
| 1 | `ctx.inject(['inputTriggers'])` | the `@` trigger service; `ctx.get` alone cannot see it |
| 2 | `controller.toggleSource('reference', hit)` | opens the reference menu from a **synthetic hit** (`trigger:'@'`, `query:<title>`), no typing required |
| 3 | `controller.pick('reference', index)` | → `settle()` → `execute()` → official event `slash/input-insert-reference` |
| 4 | `hit.span.draftRev` | the input machine CAS-checks the insertion. The revision is captured by wrapping `controller.track(draft, caret, guard, draftRev)` (called on load, then once per edit) |

A title query narrows candidates to the target session (otherwise files and folders come first). When the revision is unknown the plugin probes `[lastTrack.rev, 0..8]`; a CAS miss inserts nothing, so probing is safe.

## Compatibility

| Host | Status |
|---|---|
| DSH Desktop `0.2.1-rc.3` (Electron 44.7, Chrome 152) | verified end-to-end (chip inserted, `rev = 8`) |
| Older lines | not tested; `engines.dsh` refuses them |
| Future lines | degrades to "send a reference message" instead of failing |

## Pitfalls (learned the hard way)

1. Never write text into the Lexical composer and expect the `@` menu — it only leaves garbage.
2. Never set `dataTransfer.dropEffect = 'copy'`: the official drag is `move`, and a mismatch makes the browser **cancel the drop** (highlight shows, release does nothing).
3. Never edit `client.js` while the page is running and then reload: the loader can read a half-written bundle → `import failed` → **the whole web boot fails**. Use: disable bundle → edit → `node --check` → enable.
4. Document-level `drop` listeners must use the **bubble** phase (capture runs before the component's `onDrop` and unmounts it).

## Limits

- At most **3** session references per message (host limit `MAX_REFERENCES`).
- Reference bodies are injected by `@deepseek-ai/dsh-session-reference` as a bounded snapshot (64 KB by default, truncated tail spilled to disk); only real user/assistant text is projected.
- Target sessions that are running queue the message instead of interrupting.

## Install / disable

```powershell
plugin_manager { action: "install_bundle", target: "<path or package spec>" }
plugin_manager { action: "set_bundle", target: "dsh-drag-graft", enabled: false }
plugin_manager { action: "remove_bundle", target: "dsh-drag-graft" }
```

If a bad build ever blocks boot, the desktop offers **"Disable third-party plugins, back up profile patch and restart"**.

## Development

```powershell
npm run check   # syntax + manifest/contract tests (node --test)
```

Diagnostics: the client half exposes `window.__dragGraft` (`state()`, `controller()`, `insert(id, title)`) for CDP inspection; it performs no writes by itself.

MIT licensed.
