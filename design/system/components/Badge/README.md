# Badge

A short status label. Every status in the product (workspace state, check result, Git letter, needs input, agent and accent tags) is one Badge, so they share one height, radius and type.

**Maps to:** a `<span>`. **Consumer provides:** `tone`, `children` (a glyph and a word, or a single Git letter), and optional `plain`, which drops the fill and padding for a status bar.

| tone | text | fill | used for |
| --- | --- | --- | --- |
| `success` | `status-running` | `status-running-soft` | Running, passed, Git added and untracked |
| `warning` | `status-warning` | `status-warning-soft` | Needs input, Git modified, limits |
| `danger` | `status-error` | `status-error-soft` | Error, failed, Git deleted |
| `info` | `status-starting` | `status-starting-soft` | Setting up, starting, restarting, Git renamed |
| `neutral` | `status-stopped` | `status-stopped-soft` | Stopped, stopping |
| `accent` | `accent-text` | `accent-soft` | A selected or current marker |
| `agent` | `agent-text` | `agent-soft` | Something a coding agent owns |

- 22px tall and at least 22px wide, `radius-sm`, 12px at 600 weight, `space-2` side padding, `space-1.5` between glyph and word.
- Every tone's text meets 4.5:1 on its fill in both themes.
- On administrator and course pages a badge marks an exception only (an error, a throttled or flagged workspace, a waiting invitation). A normal state there is `plain`: the glyph and word with no fill. A count of errors that is zero is neutral, never red.
- A Badge never carries colour alone: it holds a word, or a letter whose meaning the row's accessible name spells out.
- `StateBadge` and the Git letter (`GitLetter` in `apps/web`) are thin wrappers that choose the tone and glyph. Do not draw a new pill for a new status; pick a tone.
- Git conflict keeps its own hue (`git-conflict` on `git-conflict-soft`) outside the tone set, so a conflict never looks like an ordinary change (SPEC 12.8).
