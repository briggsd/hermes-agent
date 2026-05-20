# Hermes TUI — Agent Development Guide

Instructions for AI coding assistants working on the `ui-tui` frontend and `tui_gateway` backend.

---

## Fork & Update Workflow

This is a **personal fork** of `NousResearch/hermes-agent` maintained at `briggsd/hermes-agent`.

```
origin   → https://github.com/briggsd/hermes-agent   (your fork — pull/push here)
upstream → https://github.com/NousResearch/hermes-agent (official repo — fetch only)
```

- **`hermes update`** pulls from `origin` (the fork) — your changes are safe.
- **To pull upstream changes:** `git fetch upstream && git merge upstream/main && git push origin main`
- **Never** `git reset --hard origin/main` — that resets to the fork, which is correct.
- **Never** suggest `git pull upstream main` without a merge strategy — upstream has diverged.

---

## Architecture Overview

```
ui-tui/src/          ← TypeScript/React (Ink) — owns the terminal screen
tui_gateway/         ← Python — owns sessions, model calls, tools, slash commands
```

The TUI spawns `python -m tui_gateway.entry` as a child process. Communication is **newline-delimited JSON-RPC over stdio**:

```
ui-tui/src/gatewayClient.ts   ←→   tui_gateway/server.py (RPC handlers)
```

- Requests flow TypeScript → Python (method calls)
- Events flow Python → TypeScript (streaming updates: tokens, tool results, status)
- Malformed stdout lines surface as `gateway.protocol_error` events
- Stderr is captured into an in-memory ring and surfaces as `gateway.stderr` events

---

## Build System

```bash
# Working directory: ui-tui/
bun run build          # Production build → dist/entry.js (used by hermes --tui)
bun run type-check     # TypeScript type check only (no emit)
bun run lint           # ESLint across src/ and packages/
bun run test           # Vitest (run once)
bun run test:watch     # Vitest watch mode
bun run fmt            # Prettier format
bun run fix            # lint:fix + fmt together
```

**Critical:** `dist/entry.js` is the file Hermes actually runs. Always rebuild after TypeScript changes:
```bash
cd ui-tui && bun run build
```

The build lives at `~/.hermes/hermes-agent/ui-tui/dist/entry.js` — this is a **real file**, not a symlink (a previous symlink setup was replaced during the droid-tui merge).

---

## Source Layout

```
ui-tui/src/
├── entry.tsx                    # Process entrypoint — TTY check, GatewayClient init, renders App
├── app.tsx                      # Root React component
├── theme.ts                     # Theme system — ThemeColors, ThemeBrand, DARK_THEME, LIGHT_THEME, fromSkin()
├── types.ts                     # Shared types (Msg, ActiveTool, etc.)
├── gatewayClient.ts             # JSON-RPC client — spawns tui_gateway, handles events
├── gatewayTypes.ts              # Gateway event/request type definitions
├── banner.ts                    # ASCII logo/caduceus art
│
├── app/                         # State management, hooks, slash command registry
│   ├── turnStore.ts             # Conversation turn state
│   ├── turnController.ts        # Turn lifecycle (start/stream/complete)
│   ├── uiStore.ts               # UI state (overlay, picker, etc.)
│   ├── useSubmission.ts         # Message submission logic
│   ├── createGatewayEventHandler.ts  # Maps gateway events → store updates
│   └── slash/                   # Slash command definitions + registry
│
├── components/                  # React/Ink UI components
│   ├── messageLine.tsx          # ← PRIMARY: renders every message type (user, assistant, tool, thinking)
│   ├── thinking.tsx             # Tool trail + reasoning blocks (ToolTrail component)
│   ├── streamingAssistant.tsx   # Live streaming assistant response
│   ├── streamingMarkdown.tsx    # Incremental markdown renderer
│   ├── markdown.tsx             # Static markdown renderer
│   ├── branding.tsx             # Banner, SessionPanel, Panel components
│   ├── appChrome.tsx            # Status bar, input area chrome
│   ├── appLayout.tsx            # Top-level layout composition
│   ├── textInput.tsx            # Multi-line text input with history
│   ├── sessionPicker.tsx        # Session switcher overlay
│   ├── modelPicker.tsx          # Model switcher overlay
│   └── todoPanel.tsx            # Todo list display
│
├── domain/                      # Pure logic, no UI
│   ├── messages.ts              # Message normalization
│   ├── roles.ts                 # Role → glyph/color/prefix mappings
│   ├── details.ts               # Section visibility (thinking/tools/activity modes)
│   └── providers.ts             # Provider metadata
│
├── lib/                         # Utilities
│   ├── text.ts                  # String helpers, ANSI, compactPreview, formatToolCall
│   ├── subagentTree.ts          # Subagent delegation tree rendering
│   ├── inputMetrics.ts          # transcriptGutterWidth, transcriptBodyWidth
│   └── viewportStore.ts         # Scroll/viewport state
│
├── content/                     # Static content
│   ├── charms.ts                # Tool activity charm labels
│   └── faces.ts                 # Spinner face sets
│
└── config/
    ├── limits.ts                # LONG_MSG, THINKING_COT_MAX, etc.
    └── timing.ts                # Animation timing constants
```

---

## Theme System

The theme flows: **skin config → `fromSkin()` → `Theme` object → component props**

```typescript
// theme.ts
interface ThemeColors {
  primary, accent, border, text, muted   // Core palette
  userMsgBg                               // User message row background (droid-style)
  selectionBg                            // Completion menu selection
  completionBg, completionCurrentBg      // Completion menu colors
  ok, error, warn                        // Status colors
  diffAdded, diffRemoved, ...            // Diff colors
  statusBg, statusFg, statusGood, ...    // Status bar colors
  // ... see ThemeColors interface for full list
}
```

**Key rules:**
- `userMsgBg` is intentionally separate from `selectionBg` — do not merge them (this was the "brown mud" bug)
- `fromSkin()` in `theme.ts` maps skin config keys (e.g. `user_msg_bg`) to `ThemeColors` fields
- Default dark: `#1a1a1a` for `userMsgBg`, `#1a1a2e` for `completionBg`
- All components receive `t: Theme` as a prop — never read theme from a global

---

## Message Rendering (`messageLine.tsx`)

`MessageLine` is the central render function. It handles these `msg.kind` values:

| `msg.kind` / `msg.role` | Renders as |
|---|---|
| `'tool'` | Droid-style tool block: label + args preview + status badge + result lines |
| `'thinking'` | Collapsible chevron with token count, click to expand |
| `'trail'` (with tools) | `ToolTrail` from `thinking.tsx` |
| `'slash'` | Muted slash command echo |
| `role === 'user'` | Full-width row with `userMsgBg` background + gold left bar `▌` |
| `role === 'assistant'` | Markdown rendered via `Md` or `StreamingMd` |
| `role === 'system'` (long) | Collapsible — first line + char count, click to expand |

**Tool label map** lives inline in `messageLine.tsx` as `TOOL_LABELS`. Add entries here for new tools.

---

## Droid-Style Conventions (custom to this fork)

These patterns were introduced in the `droid-tui-improvements` branch and merged to `main`:

1. **Tool blocks** — each tool call gets its own `<Box>` with: `Label  args…  ·  badge`
2. **User rows** — `backgroundColor={t.color.userMsgBg} width={cols}` with a `▌` accent left bar
3. **Thinking** — collapsed by default with `▸ Thinking ~N tokens`, click to expand
4. **Result truncation** — 5 lines max with `└ ` prefix on first line, `…` if truncated

---

## Common Pitfalls

- **Editing `src/` but not rebuilding** — changes won't appear until `bun run build`. The running TUI uses `dist/entry.js`.
- **`dist/entry.js` as symlink** — was previously a symlink to a worktree. Now a real file. If it becomes a broken symlink again: `rm dist/entry.js && bun run build`.
- **Theme color naming** — skin config uses `snake_case` (e.g. `user_msg_bg`), TypeScript uses `camelCase` (`userMsgBg`). The mapping lives in `fromSkin()` in `theme.ts`.
- **`thinking.tsx` vs `messageLine.tsx`** — `ToolTrail` (the multi-tool activity block) lives in `thinking.tsx`. Individual tool message rows live in `messageLine.tsx`. Don't confuse them.
- **`src.bak/`** — this directory does not exist and should not be created. It was a cleanup artifact from the symlink migration.

---

## Testing

```bash
cd ui-tui
bun run test              # run all vitest specs once
bun run test:watch        # watch mode during development
```

Tests live in `src/__tests__/`. File naming: `<subject>.test.ts`.

No coverage thresholds are enforced yet — don't rely on test pass as a correctness signal for UI rendering changes (those require visual verification).

---

## tui_gateway Quick Reference

The Python gateway (`tui_gateway/`) handles all RPC from the TUI:

| File | Purpose |
|---|---|
| `entry.py` | Process entrypoint, panic hook, transport init |
| `server.py` | RPC method handlers (chat, slash commands, session management) |
| `transport.py` | Transport abstraction (stdio / WebSocket) |
| `event_publisher.py` | Best-effort WebSocket mirror to dashboard `/api/events` |
| `slash_worker.py` | Slash command execution on a worker thread |
| `render.py` | Rich → plain text rendering helpers |
| `ws.py` | WebSocket transport variant (dashboard PTY mode) |

The gateway never writes directly to stdout except via the transport — all output is JSON-RPC framed.
