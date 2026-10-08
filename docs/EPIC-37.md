# Epic 37: Bug fixes

A fix batch of 27 bug issues filed from the old backlog. No architect
design (WORKFLOW.md, "Epic plans": not for small fix batches). The last
task folds what lasts into SPEC.md and STATUS.md and deletes this file.

## Tasks

Each task owns its files; no two tasks edit the same file. Task pull
requests do not edit SPEC.md, STATUS.md or `e2e/helpers.ts` (T5 owns
it). Each puts its proposed STATUS line and any SPEC change in its pull
request body for the fold.

| Task | Area | Issues |
|---|---|---|
| T1 | Workspace agent | #1253 full disk on clone or template answers STORAGE_FULL; #1231 cap on concurrent searches |
| T2 | Controller and worker | #1292 exec socket error is its own error; #1291 force-stop after a failed start; #1286 future check time is stale, refresh interval capped; #1283 Claude Code managed settings restored at start |
| T3 | API and contracts | #1287 refused terminal leaves no recovery point; #1244 RATE_LIMITED for the recovery-point limit; #1275 duplicate keys refused in a Google key file; #1299 job folder without status listed as running; #1239 total layout cap per user; #1277 sizes of existing images |
| T4 | Web | #1271 keycap emoji in clone names; #1267 large images and PDFs refresh on change; #1238 preview port minimum comes only from the API |
| T5 | Flaky browser tests | #1301 grace-period test; #1295 notifications test; #1282 toast helper |
| T6 | Infra, packaging, root shell | #1269 setup leaves disabled services alone; #1274 egress handler uses the helper; #1270 image build on an apt-installed VM; #1290 rehearsal LTI platforms file; #1297 root-shell off switch ends stray processes; #1300 root-shell relay test race |
| T7 | Tooling | #1285 comment check reads regex literals, quoted strings and CSS colours |
| T8 | Fold | SPEC.md and STATUS.md from the task pull request bodies; delete this plan |

## Rulings

- #1300 moved from T5 to T6, which already changes the same root-shell test for #1297.
- #1238: the smallest change. The browser drops its own copy of the port minimum; a Preview tab opens and shows the API's refusal. No new API route.
- No migration is expected (next free number 0041 if one turns out to be needed; ask first).

## Left out

#1222 and #1242 (a data-safety epic), #1254, #1255 and #1259 (larger
designs), #1226, #1230 and #1235 (features), #1268 (needs a tmux
change), #1261 (release workflow), #1302 (decide when it happens).

## Verification

Each task: a failing test first, then the fix; typecheck, lint, unit
tests, and Playwright for anything visible. After all tasks land: code
review, security review (T2, T6, root shell), accessibility review (T1
and T4 messages), and a rehearsal VM pass (install, smoke test, a
disabled service stays disabled across an upgrade, root-shell off
switch).
