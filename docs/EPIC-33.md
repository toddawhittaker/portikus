# Epic 33 — UI polish: admin layouts, Settings, and backlog UI items

This plan lives only on `epic/33-ui-polish`. The last task folds its
lasting rules into SPEC.md (sections 20, 25.8 and 29) and deletes it.

## Scope

- Issue #1087: the admin and Settings content shift (no
  `scrollbar-gutter`), and the Network, Backups, Certificate, Docker and
  Settings layout findings. The issue's findings and acceptance criteria
  are the spec for those tasks.
- Issue #1096: the signed apt repository test's throwaway key.
- BACKLOG.md UI items: a larger unread badge; "Still working?" under an
  open dialog; sortable admin tables and a table component; admin tabs in
  the app header; per-row "more" menus in admin tables; shared storage
  thresholds for the admin detail panel; a radio-item menu component;
  heat map values for sighted keyboard users; Monitor buttons while Find
  in files is open; Course page at narrow widths; status bar overflow and
  page reflow at narrow widths; the shell's storage meters on `Meter`; a
  "moving" option for StateBadge; announce an admin rebuild result after
  the panel closes; an end toast for Replace home folder; keep the old
  save error while the disk stays full; a shared file input in
  `packages/ui`.
- The review step includes the backlog's "full accessibility audit of
  the student interface": a11y-reviewer covers the whole student UI, not
  only this epic's diff.

Left out: CSV table view, Extract progress and the idle-lift notification
(features, not polish); a tablet admin layout (SPEC.md section 20.1 keeps
the admin area desktop-only); Docker download sizes and image sizes
(backend); the VoiceOver check (needs a Mac).

## Rules for every task

- Read SPEC.md section 25.8 (accessibility) and docs/DESIGN.md first.
- Unit tests for logic and Playwright tests for anything visible, both
  themes for axe scans. A scrollbar-width test needs
  `launchOptions: { ignoreDefaultArgs: ["--hide-scrollbars"] }`.
- Layout follows the container (`@container`), not the viewport.
- No file over 800 lines; do not grow one that already is.
- Do not edit `docs/STATUS.md`; put a "Proposed STATUS line:" in the PR
  body. Do not edit files another task owns (table below).

## Tasks

| Task | Branch | Owns | Starts |
|---|---|---|---|
| T0 apt key age (#1096) | task/33-apt-key-age | `scripts/tests/publish-apt-repo-test.sh` | now |
| T1 admin frame | task/33-admin-frame | `AdminPage.tsx` main element, `AdminSection.tsx` (`AdminGroup` gains optional `description`), Settings pane gutter in `SettingsDialog.tsx` (one class), `ProfilePane.tsx` loading Skeleton; #1087 section 1 and its three Playwright tests | now |
| T2 student shell | task/33-student-shell | `shell/StatusBar.tsx`, `shell/StorageMeters.tsx`, `shell/IdleNotice.tsx`, `shell/FilesPane.tsx`, `work/FileLeaf.tsx`, `recovery/storage.ts`, the workspace dialog meters, `admin/workspace-detail/ResourcesSection.tsx` meters; items: status bar at 560 px, meters on `Meter`, shared thresholds in the detail panel, Monitor buttons vs Find in files, Still working? under a dialog, keep old save error | now |
| T3 small components | task/33-ui-components | `packages/ui` menu (radio item) and its export, `preview/PreviewLeaf.tsx` width menu, `course/CoursePage.tsx`, `admin/health/UsageHeatMap.tsx`; items: radio-item menu, Course page narrow, heat map keyboard cursor | now |
| T4 admin tables | task/33-admin-tables | `admin/WorkspacesTab.tsx`, `admin/logs/LogsTab.tsx`, `admin/audit/AuditTab.tsx`, table CSS in `app.css`, a new `Table` component; items: sortable headers, per-row "more" menus on Users; split `WorkspacesTab.tsx` and `LogsTab.tsx` under 800 lines | now |
| T5 Network | task/33-network | `admin/network/*`; #1087 section 2 | after T1 |
| T6 Backups | task/33-backups | `admin/backups/BackupsTab.tsx` and new files split from it (not `BackupDialogs.tsx`); #1087 section 3 | after T1 |
| T7 Certificate | task/33-certificate | `admin/certificate/*`, a new file input in `packages/ui/src/forms` and its export; #1087 section 4 and the shared file input | after T1 |
| T8 Docker | task/33-docker | `admin/docker/*`; #1087 section 5 | after T1 |
| T9 Settings layout | task/33-settings | `settings/*` except T1's lines; #1087 section 6 | after T1 |
| T10 header | task/33-header | `shell/AppHeader.tsx`, the admin tab nav in `AdminPage.tsx`; items: admin tabs in the header (mockup `.pk-adminnav`), larger unread badge | after T1 |
| T11 admin operations | task/33-admin-ops | `admin/workspace-detail/AccountSection.tsx`, `admin/backups/BackupDialogs.tsx`, `packages/ui` StateBadge, a Users-view watcher; items: rebuild/reset toast after the panel closes, Replace home end toast, StateBadge "moving" | after T4 |
| T12 fold | task/33-fold | SPEC.md, STATUS.md, BACKLOG.md (remove delivered items), delete this plan | last |

## Review and verification

After the code tasks land: code-reviewer (epic diff plus dead code),
a11y-reviewer (epic diff plus the whole student interface), and a
ui-designer review of screenshots in both themes at 1440 and 1024 px.
Findings are fixed by further task PRs. Then the full battery
(`make check`, `pnpm test:e2e` on a fresh database), pilot install and
smoke test, and the epic PR to main.
