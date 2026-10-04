# Epic 34: Internet launch

This is the working plan for Epic 34. It is deleted by its last task (T17), which folds the lasting rules into SPEC.md. Where it is silent, `docs/SPEC.md` wins on behaviour and `docs/STACK.md` on technology.

- **Base:** `epic/34-internet-launch`. Builders branch `task/34-<name>` from `origin/epic/34-internet-launch`.
- **Milestone:** "Internet launch".
- **Requirements:** SPEC.md section 24, in particular 24.13 (Sign-in abuse and rules), which cites the issues below.

## Goal

Make a Portikus site safe on the open internet: a rented host with a public address, installed with `apt install`, serving HTTPS directly on port 443 with the Let's Encrypt wildcard certificate, on one domain, where nobody signs themselves up.

## Rulings (Todd, 2026-10-04)

- Cloudflare Tunnel is dropped (#916 closed). The site uses one domain.
- Nobody signs up. The install administrator adds every account.
- Only a Portikus invitation counts as administrator-created, for every provider, always on (#1136).
- Every Dex local-password account must have a second factor. It is built inside Portikus, with time-based codes and passkeys (#914).
- If someone loses both password and factor, an administrator may reset both, and the account holder is always told (#1135). This relaxes the wording of SPEC.md 24.13 and 20.2, which the fold task updates.
- Alerts are admin notifications with tone warning or danger. They are pushed to Pushover, then to webhooks. The webhook body is `{text, title, tone, site, at}`. Email comes later (#918).
- The off-server backup copy goes by rsync over SSH with a dedicated key. Disk encryption is deferred (#1142).

## Tasks

| ID | Issue | What | Agent | Wave | Status |
|---|---|---|---|---|---|
| T2 | #1133 | Sign-in limits, Dex password relay, breached-password list | builder | 1 | built (in wave-1 infra PR) |
| T4a | #918 | Worker alerts | builder | 1 | PR #1149 |
| T5 | #1134 | Outbound abuse limits | infra | 1 | built (wave-1 infra PR) |
| T6 | #1137 | Host hardening | infra | 1 | built (wave-1 infra PR) |
| T8 | #1140 | Per-user socket caps | builder | 1 | PR #1148 |
| T9 | #1143 | Content security policy | ui-designer | 1 | PR #1150 |
| T10 | #1139 | Certificate before password | infra | 1 | built (wave-1 infra PR) |
| T13 | #914 | Second factor (migration 0038) | builder | 2 | in progress |
| T11 | #1142 | Off-server backup copy | infra | 2 | in progress |
| T3 | #1136 | Invitations (migration 0037) | builder | 2 | after T13 (shares the migrations index) |
| T4b | #918 | Alerts infrastructure: `alerts.env`, egress hosts, `OnFailure` calling `portikus alert` | infra | 2 | |
| T7 | #1140 | Caddy timeouts, header limits, `frame-ancestors`, preview `nosniff` | infra | 2 | |
| T19 | | Logs tab shows the outbound-limit kernel log lines (gap from T5) | builder | 2 | |
| T15 | #1132 | CSV bulk upload | builder + ui-designer | 3 | after T3 |
| T12 | #1141 | One-hour re-sign-in for sessions whose administrator or instructor role comes from the provider | builder | 3 | |
| T14 | #1135 | Reset notifications, install-administrator protection, admin second-factor reset | builder | 3 | |
| T16 | #1138 (part) | Security test on a plain host, audit-coverage test | tester | 4 | |
| T17 | | Fold (see below) | builder | 5 | |
| T18 | #919 | Whole-epic security review and external port check | security-reviewer | 5 | |

T17 folds into SPEC.md (including the 21.12 priority sentence, the section 23 change from `names_v4` to `learned_v4` and `recent_v4`, and the 24.13 and 20.2 reset wording), STATUS.md, INSTALL.md (the #1146 HTTP-01 line and the off-server copy), OPERATIONS.md, and BACKLOG.md for deferrals. It then deletes this plan.

## Shared-file owners

Tasks that touch the same file go in this order.

- `Caddyfile.j2`: T2 in wave 1, then T7.
- `site.yml`: T6, then T4b.
- Migrations index and schema: T13, then T3.
- `contracts/src/admin.ts` and the admin Users view: T3, then T15, then T14.
- `packages/auth` plugin and sessions: T13, then T12.
- Only T17 edits `docs/STATUS.md` and `docs/SPEC.md`. Other tasks put their proposed STATUS line in the PR body.

## Deferred

- Disk encryption (part of #1142): to BACKLOG.
- Provider sign-out (#1144): to BACKLOG.
- Agent pins in the admin image rebuild (#1145) and the rest of #1138: the next fix batch.
- Making the Dex CI job required is a ruleset change, which is Todd's to make.

## Verification

- Infrastructure tasks are verified on the rehearsal VM, from install through the smoke test, before their pull request opens.
- Every visible change ships with Playwright tests.
- For T16 and the external port check (T18), the epic head goes onto a fresh apt-installed host.
