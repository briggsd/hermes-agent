import { Ansi, Box, NoSelect, Text } from '@hermes/ink'
import { memo, useState } from 'react'

import { LONG_MSG } from '../config/limits.js'
import { sectionMode } from '../domain/details.js'
import { userDisplay } from '../domain/messages.js'
import { ROLE } from '../domain/roles.js'
import { transcriptBodyWidth, transcriptGutterWidth } from '../lib/inputMetrics.js'
import {
  boundedLiveRenderText,
  compactPreview,
  hasAnsi,
  isPasteBackedText,
  sanitizeAnsiForRender,
  stripAnsi
} from '../lib/text.js'
import type { Theme } from '../theme.js'
import type { ActiveTool, DetailsMode, Msg, SectionVisibility } from '../types.js'

import { Md } from './markdown.js'
import { StreamingMd } from './streamingMarkdown.js'
import { ToolTrail } from './thinking.js'
import { TodoPanel } from './todoPanel.js'

// Collapse threshold for long system messages (system prompt etc.)
const SYSTEM_COLLAPSE_CHARS = 400

export const MessageLine = memo(function MessageLine({
  cols,
  compact,
  detailsMode = 'collapsed',
  detailsModeCommandOverride = false,
  isStreaming = false,
  msg,
  sections,
  t,
  tools = []
}: MessageLineProps) {
  // Per-section overrides win over the global mode, so resolve each section
  // we might consume here once and gate visibility on the *content-bearing*
  // sections only — never on the global mode.  A `trail` message feeds Tool
  // calls + Activity; an assistant message with thinking/tools metadata
  // feeds Thinking + Tool calls.  Gating on every section would let
  // `thinking` (expanded by default) keep an empty wrapper alive when only
  // `tools` is hidden — exactly the empty-Box bug Copilot caught.
  const thinkingMode = sectionMode('thinking', detailsMode, sections, detailsModeCommandOverride)
  const toolsMode = sectionMode('tools', detailsMode, sections, detailsModeCommandOverride)
  const activityMode = sectionMode('activity', detailsMode, sections, detailsModeCommandOverride)
  const thinking = msg.thinking?.trim() ?? ''

  // Collapse toggle for long system messages
  const systemIsLong = msg.role === 'system' && msg.text.length > SYSTEM_COLLAPSE_CHARS
  const [systemOpen, setSystemOpen] = useState(false)
  const [thinkingOpen, setThinkingOpen] = useState(false)

  if (msg.kind === 'trail' && msg.todos?.length) {
    return (
      <TodoPanel
        defaultCollapsed={msg.todoCollapsedByDefault}
        incomplete={msg.todoIncomplete}
        t={t}
        todos={msg.todos}
      />
    )
  }

  // Droid-style per-tool block.  Each tool gets its own block with:
  //   Label  args/preview                       status
  //   └ result lines (indented, truncated)
  if (msg.kind === 'tool') {
    if (toolsMode === 'hidden') return null
    const rawName = msg.toolName ?? 'tool'
    const args = (msg.toolArgs ?? '').trim()
    const status = msg.toolStatus ?? 'executing'
    const result = (msg.toolResult ?? '').trim()
    const took = msg.toolDuration !== undefined ? `${msg.toolDuration.toFixed(1)}s` : ''
    const isExecuting = status === 'executing'
    const isError = Boolean(msg.toolError)

    // Human-readable label for common tools
    const TOOL_LABELS: Record<string, string> = {
      terminal: 'Execute',
      search_files: 'Search',
      read_file: 'Read File',
      write_file: 'Write File',
      web_search: 'Web Search',
      web_extract: 'Fetch',
      mcp_browser_navigate: 'Browse',
      mcp_browser_click: 'Click',
      mcp_browser_type: 'Type',
      mcp_browser_snapshot: 'Snapshot',
      mcp_browser_vision: 'Vision',
      patch: 'Edit',
      execute_code: 'Run Code',
      delegate_task: 'Delegate',
    }
    const label = TOOL_LABELS[rawName] ?? rawName.replace(/_/g, ' ').replace(/\b\w/g, c => c.toUpperCase())
    const labelColor = isError ? t.color.error : isExecuting ? t.color.accent : t.color.accent

    // Status badge (right-aligned)
    const badge = isExecuting ? '●' : isError ? 'error' : took
    const badgeColor = isExecuting ? t.color.accent : isError ? t.color.error : t.color.muted

    // Args preview — leave room for label + badge
    const maxArgs = Math.max(20, cols - label.length - badge.length - 10)
    const previewArgs = args.length > maxArgs ? args.slice(0, maxArgs - 1) + '…' : args

    // Result: show up to 5 lines, truncating each line to terminal width
    const resultLines = result
      ? result.split('\n').slice(0, 5).map(l => l.slice(0, Math.max(40, cols - 8)))
      : []
    const resultTruncated = result ? result.split('\n').length > 5 : false

    return (
      <Box flexDirection="column" marginLeft={2} marginTop={1}>
        {/* Header row: Label  args  ·  badge */}
        <Box>
          <Text bold color={labelColor}>{label}</Text>
          {previewArgs ? (
            <Text color={t.color.text}> {previewArgs}</Text>
          ) : null}
          <Text> </Text>
          <Text color={badgeColor} dimColor={!isExecuting && !isError}>{badge}</Text>
        </Box>
        {/* Result block */}
        {resultLines.length > 0 && (
          <Box flexDirection="column" marginLeft={2} marginTop={0}>
            {resultLines.map((line, i) => (
              <Text color={t.color.muted} key={i} wrap="truncate-end">
                {i === 0 ? '└ ' : '  '}{line}
              </Text>
            ))}
            {resultTruncated && (
              <Text color={t.color.muted} dimColor>  …</Text>
            )}
          </Box>
        )}
      </Box>
    )
  }

  // Droid-style live-thinking block.  Renders as a collapsed chevron with
  // the running token count while reasoning streams in. Clickable to expand.
  if (msg.kind === 'thinking') {
    if (thinkingMode === 'hidden') return null
    const tokens = msg.thinkingTokens ?? 0
    const preview = (msg.thinking ?? '').trim()
    if (!preview) return null
    return (
      <Box flexDirection="column" marginLeft={3}>
        <Box onClick={() => setThinkingOpen(v => !v)}>
          <Text color={t.color.accent}>{thinkingOpen ? '▾ ' : '▸ '}</Text>
          <Text color={t.color.muted}>Thinking</Text>
          {tokens > 0 ? (
            <Text color={t.color.muted} dimColor> ~{tokens.toLocaleString()} tokens</Text>
          ) : null}
        </Box>
        {thinkingOpen ? (
          <Box marginLeft={2} marginTop={0}>
            <Text color={t.color.muted} wrap="wrap">{preview}</Text>
          </Box>
        ) : null}
      </Box>
    )
  }

  if (msg.kind === 'trail' && (msg.tools?.length || tools.length || thinking)) {
    // tools.length > 0 means this is the live-turn active-tools block from StreamingAssistant
    const isLiveTurn = tools.length > 0
    return thinkingMode !== 'hidden' || toolsMode !== 'hidden' || activityMode !== 'hidden' ? (
      <Box flexDirection="column">
        <ToolTrail
          busy={isLiveTurn}
          commandOverride={detailsModeCommandOverride}
          detailsMode={detailsMode}
          reasoning={thinking}
          reasoningTokens={msg.thinkingTokens}
          sections={sections}
          t={t}
          tools={tools}
          toolTokens={msg.toolTokens}
          trail={msg.tools ?? []}
        />
      </Box>
    ) : null
  }

  if (msg.role === 'tool') {
    const maxChars = Math.max(24, cols - 14)
    const stripped = hasAnsi(msg.text) ? stripAnsi(msg.text) : msg.text
    const safeAnsi = hasAnsi(msg.text) ? sanitizeAnsiForRender(msg.text) : msg.text
    const preview = compactPreview(stripped, maxChars) || '(empty tool result)'

    return (
      <Box alignSelf="flex-start" borderColor={t.color.muted} borderStyle="round" marginLeft={3} paddingX={1}>
        {hasAnsi(msg.text) ? (
          <Text wrap="truncate-end">
            <Ansi>{safeAnsi}</Ansi>
          </Text>
        ) : (
          <Text color={t.color.muted} wrap="truncate-end">
            {preview}
          </Text>
        )}
      </Box>
    )
  }

  const { body, glyph, prefix } = ROLE[msg.role](t)
  const gutterWidth = transcriptGutterWidth(msg.role, t.brand.prompt)

  const showDetails =
    (toolsMode !== 'hidden' && Boolean(msg.tools?.length)) || (thinkingMode !== 'hidden' && Boolean(thinking))

  const content = (() => {
    if (msg.kind === 'slash') {
      return <Text color={t.color.muted}>{msg.text}</Text>
    }

    // ── Collapsible long system message (system prompt, AGENTS.md, etc.) ──
    // MUST come before the hasAnsi check — system messages from the backend
    // contain Rich markup escape codes that would otherwise hit <Ansi> full render.
    if (systemIsLong) {
      const firstLine = (msg.text.split('\n')[0] ?? '').trim().slice(0, 120) || '(system message)'

      return (
        <Box flexDirection="column">
          <Box onClick={() => setSystemOpen(v => !v)}>
            <Text color={t.color.accent}>{systemOpen ? '▾ ' : '▸ '}</Text>
            <Text color={t.color.muted}>{firstLine}</Text>
            <Text color={t.color.muted} dimColor>
              {' — '}
              {msg.text.length.toLocaleString()} chars
            </Text>
          </Box>
          {systemOpen && <Ansi>{sanitizeAnsiForRender(msg.text)}</Ansi>}
        </Box>
      )
    }

    if (msg.role !== 'user' && hasAnsi(msg.text)) {
      return <Ansi>{sanitizeAnsiForRender(msg.text)}</Ansi>
    }

    if (msg.role === 'assistant') {
      const bodyWidth = transcriptBodyWidth(cols, msg.role, t.brand.prompt)

      return isStreaming ? (
        // Incremental markdown: split at the last stable block boundary so
        // only the in-flight tail re-tokenizes per delta. See
        // streamingMarkdown.tsx for the cost model.
        <StreamingMd cols={bodyWidth} compact={compact} t={t} text={boundedLiveRenderText(msg.text)} />
      ) : (
        <Md cols={bodyWidth} compact={compact} t={t} text={msg.text} />
      )
    }

    if (msg.role === 'user' && msg.text.length > LONG_MSG && isPasteBackedText(msg.text)) {
      const [head, ...rest] = userDisplay(msg.text).split('[long message]')

      return (
        <Text color={body}>
          {head}
          <Text color={t.color.muted} dimColor>
            [long message]
          </Text>
          {rest.join('')}
        </Text>
      )
    }

    return <Text {...(body ? { color: body } : {})}>{msg.text}</Text>
  })()

  // Diff segments (emitted by pushInlineDiffSegment between narration
  // segments) need a blank line on both sides so the patch doesn't butt up
  // against the prose around it.
  const isDiffSegment = msg.kind === 'diff'

  return (
    <Box
      flexDirection="column"
      marginBottom={msg.role === 'user' || isDiffSegment ? 1 : 0}
      marginTop={msg.role === 'user' || msg.kind === 'slash' || isDiffSegment ? 1 : 0}
    >
      {showDetails && (
        <Box flexDirection="column" marginBottom={1}>
          <ToolTrail
            commandOverride={detailsModeCommandOverride}
            detailsMode={detailsMode}
            reasoning={thinking}
            reasoningTokens={msg.thinkingTokens}
            sections={sections}
            t={t}
            toolTokens={msg.toolTokens}
            trail={msg.tools}
          />
        </Box>
      )}

      {msg.role === 'user' ? (
        // Droid-style user row: full-width background highlight + solid left bar
        <Box backgroundColor={t.color.userMsgBg} width={cols}>
          <NoSelect flexShrink={0} fromLeftEdge width={gutterWidth}>
            <Text color={t.color.accent}>{'▌ '}</Text>
          </NoSelect>
          <Box width={transcriptBodyWidth(cols, msg.role, t.brand.prompt)}>{content}</Box>
        </Box>
      ) : (
        <Box>
          <NoSelect flexShrink={0} fromLeftEdge width={gutterWidth}>
            <Text bold={msg.role === 'user'} color={prefix}>
              {glyph}{' '}
            </Text>
          </NoSelect>
          <Box width={transcriptBodyWidth(cols, msg.role, t.brand.prompt)}>{content}</Box>
        </Box>
      )}
    </Box>
  )
})

interface MessageLineProps {
  cols: number
  compact?: boolean
  detailsMode?: DetailsMode
  detailsModeCommandOverride?: boolean
  isStreaming?: boolean
  msg: Msg
  sections?: SectionVisibility
  t: Theme
  tools?: ActiveTool[]
}
