# 0009. Workspace agent transport and terminal model

- **Status**: Accepted
- **Date**: 2026-09-16
- **References**: STACK.md §2, §10; SPEC.md §2.6, §6.3, §9, §23.5, §26

## Context

Epic 5 puts a platform service inside every workspace container: the
workspace agent (SPEC §2.6). It has to carry terminal bytes today and file,
search, and port traffic in Epics 7 and 8. Incus already gives the
controller a websocket into a container through `exec`, so the obvious
question was whether to reuse it or open a network port. Terminals also
have to outlive the browser socket for the ten-minute grace period
(SPEC §9.2), and the control plane must be able to tell one workspace agent
from another with a per-workspace secret (SPEC §23.5).

## Decision

The agent is `apps/workspace-agent`: TypeScript, Fastify with
`@fastify/websocket`, `node-pty`, and `tmux`. It runs as the unprivileged
`student` user inside the container and listens on TCP `0.0.0.0:7400` on
the workspace bridge (`10.200.0.0/24`). The API dials it directly.

Authentication is a per-workspace bearer token. The worker mints 32 random
bytes as hex into `workspaces.agent_token` at create time. Once the instance
reaches Running, the controller writes it to `/etc/portikus/agent.token`
(uid 1000, mode 0600) through the Incus files API, then polls the agent's
`/health` before `start` returns (SPEC §6.3). The agent re-reads the file on
each request and compares with `timingSafeEqual`.

The network is what stops a student from stealing another token. The
workspace profile's nic sets `security.ipv4_filtering` and
`security.mac_filtering`, so a container cannot take a neighbour's address
and be handed that neighbour's token. The network ACL isolates peers
(SPEC §23.3) and allows tcp/7400 ingress from the gateway only, and the
`api` and `workspace-controller` systemd units carry
`IPAddressAllow=10.200.0.0/24`.

The agent is delivered by the same Debian package as the rest of the control
plane (ADR 0007). The package ships the built tree at
`/usr/lib/portikus/workspace-agent`, and the workspace profile bind-mounts
it read-only at `/opt/portikus/workspace-agent`, where the image's
pre-enabled systemd unit expects `bin/workspace-agent`.

Terminals are tmux sessions, one per terminal, named `pk-<terminalId>` with
`window-size latest`. Each browser attachment is its own `node-pty` running
`tmux attach-session -t pk-<id>`, so tmux and not the websocket owns the
shell, several clients share one attach, and a full workspace stop ends the
container and its tmux with it. Durable metadata lives in a `terminals`
table (SPEC §26); the worker sets `ended_at` when a workspace moves to
`stopping`. An attachment is now sent the lines that have scrolled off the
pane, captured with `tmux capture-pane`, before its PTY starts, and tmux
draws on a terminal stripped of the `smcup`, `rmcup`, `indn` and `rin`
capabilities so that the browser's own scrollback fills up and the mouse
wheel scrolls it. Because tmux never passes a pane program's alternate
screen through to the client, the agent's pane poll also reports
`#{alternate_on}` as a `screen` frame, and the browser turns wheel notches
into arrow keys while it is set, which is what moves nano a line at a
time.

**Rejected alternatives:**

- Tunnelling terminals through the Incus `exec` websocket via the
  controller: an extra hop per keystroke, new websocket-over-unix-socket
  code to write, and no home for the Epic 7 and 8 file and port APIs.
- Baking the agent into the workspace image: every agent change would mean
  an image rebuild, and agent and control-plane versions would drift.

## Consequences

- Upgrading the Debian package upgrades every agent at once. A running agent
  is only restarted by its unit's on-failure policy, so a new version is
  picked up when the container or the unit restarts.
- The API is a byte pipe: the browser and agent websocket frames are
  identical, so the API neither parses nor buffers terminal traffic.
- Token safety now depends on Incus network configuration as much as on
  code, so the profile nic filters and the ACL rules are security
  requirements, not tuning.
- Traffic between the API and the agent is plaintext on the workspace
  bridge. TLS between them is deferred to Gate C in Epic 12.

## Review notes

Three decisions came out of building and reviewing Epic 5. Terminal routes
and the terminal WebSocket look the workspace up by owner only, so an
administrator asking for a student's terminal gets a 404 like anyone else
(SPEC §20.2); administrators read state through their own listing route.
The worker mints a fresh agent token on every workspace start rather than
once at create time, so a token that leaked while the workspace ran stops
working at the next start. The network ACL that isolates peer workspaces
(SPEC §23.3) only has effect when the `br_netfilter` module is loaded and
`net.bridge.bridge-nf-call-iptables` is set, because Incus writes its ACL
rules into the host firewall, which otherwise never sees traffic between
two containers on the same bridge; the `incus_network` role now sets both
persistently. One residual risk: the token file sits in a directory the
`student` user owns inside the container, so containment rests on the Incus
files API resolving paths inside the instance.
