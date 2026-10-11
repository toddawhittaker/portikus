# Epic 44: site address and package removal fixes

Branch `epic/44-site-and-removal`, cut from main 64fce435. A fix batch, so
there was no architect design (WORKFLOW.md, "Epic plans"). The last task
folds this plan into SPEC.md and ADR 0059 and deletes it.

## Issues

- #1475 A site address move leaves the old name in /etc/hosts.
- #1476 The address apply route should repeat the DNS checks the page enforces.
- #1468 The certificate pre-flight reach and port-80 checks always fail from the sandboxed API.
- #1464 Epic 43 follow-ups: the preview suffix flag, the operator proxy host list, the link-search debounce, the sign-in focus move, and the root discovery fetch.
- #1477 Package removal leaves setup-written units and alert drop-ins behind.
- #1296 Run apt remove and install for real and check that nothing is left.

## Rulings

- R1 (Todd, #1477): `apt remove` stops and disables every unit setup
  wrote into /etc/systemd/system and deletes the alert drop-ins. Purge
  also deletes the unit files and drop-ins setup wrote. A reinstall
  followed by setup brings everything back.
- R2 (Todd, #1464 e): setup fetches an OIDC issuer's discovery document
  through the Squid egress proxy once Squid is running. On a first setup,
  before Squid exists, it refuses an issuer whose name resolves to a
  private, loopback or link-local address.
- R3 (#1476): the apply route repeats the DNS checks server-side and
  refuses with a dedicated error when a name does not resolve. Reach
  checks stay warnings, as on the page.
- R4 (#1468): in the certificate pre-flight, the reach and port-80 checks
  become warnings in both modes, as Epic 43 did for the site address. DNS
  checks still block. The sandbox stays as it is.
- R5 (#1475): the hosts line carries a fixed marker, so a move replaces
  the line rather than adding one.
- R6 (#1464 b): the egress_proxy role writes
  /etc/portikus/operator-proxy-hosts.json from host_entries, in the same
  shape as the page-owned proxy-hosts.json. The API reads it and drops
  SQUID_CONF_FILE.
- R7: ADR 0061 and migration 0045 are reserved for this epic, if needed.

## Tasks

| Task | Issues | Agent | Owns |
|---|---|---|---|
| T1 preflight | #1476 #1468 | builder | apps/api/src/certificate/preflight.ts; apps/api/src/routes/admin-address.ts, admin-certificate.ts and their tests; apps/web/src/admin/certificate/*; apps/web/src/admin/address/*; e2e/admin-address.spec.ts, e2e/admin-certificate.spec.ts |
| T2 followups-app | #1464 b (API side), c, d | builder | apps/api/src/site/page-files.ts; apps/api/src/routes/admin-proxy-hosts.ts; packages/config/src/index.ts; apps/web/src/admin/workspace-detail/*; apps/web/src/admin/signin/* |
| T3 setup-roles | #1475 #1464 a, b (Ansible side), e | infra | infra/ansible/roles/caddy/tasks/main.yml (hosts line only); infra/ansible/roles/egress_proxy/*; infra/ansible/roles/portikus/templates/site-view.json.j2; infra/tests/*-render-test.yml |
| T4 removal | #1477 #1296 | infra | packaging/scripts/*; packaging/tests/*; infra/tests/install-test.sh |
| T5 fold | all | builder | SPEC.md, STATUS.md, ADR 0059; deletes this plan |

After the build tasks: code, security and accessibility reviews, fixes,
confirmations, a rehearsal-VM run (a real `apt remove` and reinstall, an
address move, and certificate checks), the fold, then the epic pull request.
