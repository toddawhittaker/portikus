import { ACCOUNT_IMPORT_MAX_ROWS } from "@portikus/contracts";
import type { HelpPart } from "./part.js";

/**
 * Running the site, the administrator help. Each admin tab's intro links to one of these anchors
 * ("More in Help"), so keep the ids stable: admin-users, admin-health,
 * admin-logs, admin-audit, admin-network, admin-backups, admin-image,
 * admin-certificate, admin-docker, admin-settings, admin-notifications,
 * admin-shell, admin-signin, admin-address.
 */
export const ADMIN_HELP: HelpPart = {
	id: "admin",
	title: "Running the site",
	topics: [
		{
			id: "admin-users",
			title: "Find a person and their workspace",
			body: (
				<p>
					You land on <strong>Administration</strong> when you sign in; from your own
					workspace, open it from the account menu. The <strong>Users</strong> tab lists
					everyone who has signed in. Search by name, email, username or workspace
					label, and choose a name to open its panel. The panel shows the workspace's
					state and storage, and every action for it. The list shows 50 people at a
					time; search and filters cover everyone, and <strong>Next</strong> and{" "}
					<strong>Previous</strong> change page.
				</p>
			),
		},
		{
			id: "admin-invitations",
			title: "Inviting people",
			body: (
				<>
					<p>
						Nobody can sign up on their own. On <strong>Users</strong>, choose{" "}
						<strong>Invite…</strong> before someone's first sign-in; that sign-in
						creates their account with the role you chose. Until then they are listed at
						the end of the table as <strong>Invited</strong>, and{" "}
						<strong>Revoke…</strong> takes the invitation back.
					</p>
					<p>
						How the first sign-in is matched depends on the sign-in provider. Most
						providers must send a verified email that matches the invitation. Microsoft
						Entra does not verify email, so Portikus matches only the user principal
						name: put it in <strong>Sign-in name</strong>, or leave that empty to match
						the email. LDAP matches either the username or the email.
					</p>
					<p>
						To add many people at once, choose <strong>Import from CSV…</strong>.{" "}
						<strong>Download a sample file</strong> shows the columns: name, email,
						username, role and kind, one row per person, at most{" "}
						{ACCOUNT_IMPORT_MAX_ROWS} rows. Kind <strong>invite</strong> invites the
						person; kind <strong>password</strong> adds an account with a Portikus
						password. Role is student or instructor; add administrators one at a time.
						Portikus checks the file and marks each row Ready, Invalid or Already
						exists, and adds nothing until you confirm. Then{" "}
						<strong>Download passwords</strong> gives the one-time passwords, once only.
						Give each person theirs privately.
					</p>
				</>
			),
		},
		{
			id: "admin-broken",
			title: "When a student says their workspace is broken",
			body: (
				<ol>
					<li>
						Open their panel. If it shows <strong>Error</strong>, read the message.{" "}
						<strong>Re-provision</strong> creates the workspace again and keeps their
						home folder.
					</li>
					<li>
						If it is <strong>Throttled</strong>, it used a lot of CPU for a long time.{" "}
						<strong>Lift throttle</strong> gives full speed back.
					</li>
					<li>
						If Docker is stuck or full, <strong>Reset Docker</strong> deletes every
						Docker image, container and volume in the workspace. Projects and home stay.
					</li>
					<li>
						<strong>Rebuild workspace</strong> recreates the workspace from the current
						image. Projects and home stay, and Docker data too unless you untick it.
						Packages installed with <code className="pk-mono-body">sudo apt</code> do
						not.
					</li>
				</ol>
			),
		},
		{
			id: "admin-storage",
			title: "Storage and limits",
			body: (
				<p>
					<strong>Edit quotas</strong> grows the home or Docker allocation. Sizes can
					only grow. <strong>Edit limits</strong> sets the most CPU, memory and
					processes one workspace may use; a blank field uses the site value.
				</p>
			),
		},
		{
			id: "admin-guard",
			title: "The resource guard",
			body: (
				<p>
					Portikus slows a workspace that keeps its CPUs busy for a long time, and flags
					one that uses a lot of memory. A memory flag slows nothing. Set the thresholds
					on <strong>Settings</strong>, and change them for one workspace with{" "}
					<strong>Guard settings</strong> in its panel. Throttled and flagged workspaces
					are listed on <strong>Health</strong>.
				</p>
			),
		},
		{
			id: "admin-stopping",
			title: "When workspaces stop",
			body: (
				<p>
					A workspace keeps running for the <strong>disconnect grace period</strong>{" "}
					after its last browser tab closes. With no input for the{" "}
					<strong>idle stop</strong> time, the student is asked "Still working?", and
					the workspace stops five minutes later unless they answer. Both are set on{" "}
					<strong>Settings</strong> and can be changed for one workspace from its panel.
					A student can choose <strong>Keep running</strong> to hold their workspace up
					while away; neither timer counts until the hold ends.{" "}
					<strong>Longest keep running (hours)</strong> caps the hold (default 12; 0
					turns it off), and <strong>Guard settings</strong> changes it for one
					workspace.
				</p>
			),
		},
		{
			id: "admin-network",
			title: "Internet access",
			body: (
				<p>
					<strong>Network</strong> chooses open mode, which allows every public site
					except the ones you block, or allow-list mode, which allows only the presets,
					hosts and ranges you list. Private networks are always blocked, so a range you
					add cannot overlap one. Use <strong>Test a host</strong> to see why a name
					would be allowed or refused. <strong>Refused names</strong> shows what
					workspaces tried and failed to reach over the last 7 days, for the whole site,
					never per student.
				</p>
			),
		},
		{
			id: "admin-proxy-hosts",
			title: "Allowed API hosts",
			body: (
				<p>
					On <strong>Network</strong>, <strong>Allowed API hosts</strong> lets
					workspaces reach one more host on the internet, such as an AI provider's API.
					Type a host name only: no IP address, port or web address. Each host is
					allowed on port 443 for HTTPS only, and you can add up to 50. Hosts from the
					operator's own list show read-only.
				</p>
			),
		},
		{
			id: "admin-signin",
			title: "Sign-in and learning systems",
			body: (
				<>
					<p>
						<strong>Single sign-on</strong> chooses Microsoft Entra ID, Google
						Workspace, another OpenID Connect provider, or Dex passwords only. A change
						is a trial. Choose <strong>Apply as a trial</strong>, then{" "}
						<strong>Test sign-in</strong>, then <strong>Keep</strong> once the test
						passes. A trial that is not kept is put back after 30 minutes. While a bad
						trial is open, students may not be able to sign in; the local
						administrator's Dex password always works. A saved client secret is never
						shown: leave the box empty to keep it, and type a new one if you change the
						tenant, issuer or client ID. LDAP shows read-only and is changed with{" "}
						<code>sudo dpkg-reconfigure portikus</code>.
					</p>
					<p>
						<strong>Learning management systems</strong> registers the platforms that
						may open Portikus through LTI: name, issuer, client ID, login, keyset and
						optional token addresses (all HTTPS on the default port) and deployment IDs.
						Saving restarts the API, which ends root shells and reconnects sockets. You
						can add up to 20; the operator's own platforms show read-only.
					</p>
				</>
			),
		},
		{
			id: "admin-address",
			title: "Changing the site address",
			body: (
				<>
					<p>
						<strong>Site address</strong> moves Portikus to a new host name or port in
						steps. Enter the new name and port to see the plan: the preview names, the
						certificate and the workspaces that keep their old preview names until they
						next start. The page checks DNS, that the names point at this server and
						that port 80 answers. <strong>Apply as a trial</strong> moves the site. Open
						the new address, sign in there and choose <strong>Keep</strong>. Without
						Keep, the old address comes back after 15 minutes.
					</p>
					<p>
						If the new address stops working after Keep, run{" "}
						<code>sudo dpkg-reconfigure portikus</code> on the server, or edit{" "}
						<code>portikus_public_port</code> in{" "}
						<code>/etc/portikus/portikus.yaml</code>.
					</p>
				</>
			),
		},
		{
			id: "admin-linking",
			title: "Linking accounts for someone else",
			body: (
				<p>
					In a person's panel on <strong>Users</strong>,{" "}
					<strong>Linked course accounts</strong> lists the course accounts joined to
					their SSO account. Link a course account by searching for it and confirming,
					or unlink one. The usual refusals apply, unlinking works even when the SSO
					account is disabled, the audit log records you as the actor, and the account's
					holder gets a notification.
				</p>
			),
		},
		{
			id: "admin-agent-log",
			title: "The agent log",
			body: (
				<p>
					A running workspace's panel can show the <strong>Agent log</strong>: the
					workspace agent's recent warnings and errors, kept in memory only and cleared
					by a restart. The owner of a workspace can change what its agent reports, so
					treat the lines as hints, not proof.
				</p>
			),
		},
		{
			id: "admin-backups",
			title: "Backups and restores",
			body: (
				<>
					<p>
						Each night the platform database and every workspace's home and recovery
						points are copied and encrypted, either by the server itself (a server
						installed with apt) or by a separate backup host that runs the platform's
						virtual machine. Docker data is not backed up, because Reset Docker and
						Rebuild recreate it. Until backups report to this platform, the tab says
						backups are not connected.
					</p>
					<p>
						A restore needs the <strong>restore key</strong>, the private key that
						decrypts backups, installed on the server or the backup host. The status at
						the top of the tab says whether it is.
					</p>
					<p>
						On a server that backs itself up, the <strong>Backup key</strong> section
						lets you download that key. Do it once and keep the file off the server:
						copies of the backups kept elsewhere cannot be restored without it. To
						rebuild a lost server, install a new one, choose{" "}
						<strong>Upload backup key</strong>, copy the backups onto it, and restore
						them as the install guide describes.
					</p>
					<p>
						To restore someone's files, choose <strong>Restore from backup</strong> in
						their panel, or <strong>Restore</strong> beside a set on{" "}
						<strong>Backups</strong>. Their workspace must be running. The files arrive
						in a new folder in their home, next to their current files; nothing is
						overwritten. If they need their whole home back, choose{" "}
						<strong>Replace home</strong> beside that restored copy. It swaps their
						whole home folder for the one in the same backup set, and you confirm by
						typing their workspace label. The workspace stops during the swap and starts
						again afterwards. Their previous home is kept, and listed under{" "}
						<strong>Clean up</strong> until you delete it.
					</p>
					<p>
						<strong>Clean up</strong> also lists pre-change snapshots, which the
						operator takes by hand before a risky change such as a rebuild on a new
						image, and pre-change database dumps, which the operator saves on the backup
						host before each deploy. Nothing deletes them on its own; delete them once
						the change checks out.
					</p>
				</>
			),
		},
		{
			id: "admin-health",
			title: "Health",
			body: (
				<p>
					<strong>Health</strong> shows the host and the platform now and over time.
					Read it first when many students report trouble.
				</p>
			),
		},
		{
			id: "admin-logs",
			title: "Logs",
			body: (
				<p>
					<strong>Logs</strong> shows the platform's own error, warning, info and debug
					lines. They never include students' files, commands or terminal output.
				</p>
			),
		},
		{
			id: "admin-audit",
			title: "Audit",
			body: (
				<p>
					<strong>Audit</strong> records every sign-in and every change to accounts,
					workspaces and settings, and who made it. Each action is named for its area
					and then the event, such as{" "}
					<code className="pk-mono-body">workspace.start_requested</code>. Type{" "}
					<code className="pk-mono-body">workspace.</code> in{" "}
					<strong>Action starts with</strong> to see every workspace action.
				</p>
			),
		},
		{
			id: "admin-image",
			title: "The workspace image",
			body: (
				<>
					<p>
						Every new workspace starts from the default <strong>workspace image</strong>
						. <strong>Update to latest published</strong> downloads the newest image the
						project has published and checks its signature.{" "}
						<strong>Rebuild with latest packages</strong> builds a new image on this
						host with today's Debian packages, and lets you pick Node 24 or 26 and
						whether to add Python 3.14. A rebuild takes about 20 minutes. The page shows
						each step and the log while the job runs.
					</p>
					<p>
						Each new image gets a health check, and you see what changed against the
						default. Only an image that passed can be made the default. The old default
						becomes the previous image, and <strong>Roll back</strong> swaps them again.
						Existing workspaces keep the image they were made from until you rebuild
						each one; the list shows how many workspaces run each image.
					</p>
					<p>
						Claude Code and Codex are not part of the image. They run from a shared
						folder on this host that every workspace reads, so{" "}
						<strong>Coding agents</strong> updates them without a new image.{" "}
						<strong>Update coding agents</strong> downloads the newest version of each,
						checks its signature or checksum, and tries it in a throwaway workspace.
						Each tool that passes switches on its own, so one can update while the other
						stays as it is; the job says which and why. Students get the new version the
						next time they start the tool, and open sessions keep the version they
						started with. <strong>Roll back</strong> on a tool's row goes back to its
						previous version. A rollback holds only until the next{" "}
						<strong>Update coding agents</strong>, which moves forward again to the
						newest version.
					</p>
					<p>
						<strong>Delete</strong> removes an image you no longer need and frees its
						disk space. You cannot delete the default or the previous image. Workspaces
						made from a deleted image keep working. After each fetch or build the host
						keeps the default, the previous and the newest image on its own.{" "}
						<strong>Image size (compressed)</strong> and the{" "}
						<strong>Main disk space</strong> meter show what each image costs.
					</p>
					<p>
						<strong>Packages students add</strong> counts how many workspaces added each
						package with <code className="pk-mono-body">sudo apt install</code> on the
						latest day that surveyed at least 3 of them. A package added by at least 2
						workspaces and a third of those surveyed is marked a{" "}
						<strong>base-image candidate</strong>; putting it in the image saves each
						student the install. The counts are site-wide and never name a student.
					</p>
				</>
			),
		},
		{
			id: "admin-certificate",
			title: "The site certificate",
			body: (
				<>
					<p>
						The <strong>Certificate</strong> tab shows the certificate in use for the
						site and its preview names, who issued it and when it expires, and changes
						it. The <strong>internal authority</strong> works with no setup, but each
						computer must install its root certificate, which the tab offers for
						download. <strong>ACME</strong> gets a trusted certificate from Let's
						Encrypt, ZeroSSL or another authority and renews it on its own.{" "}
						<strong>Upload files</strong> uses your institution's certificate and key,
						which you replace before they expire.
					</p>
					<p>
						For ACME, <strong>DNS-01</strong> needs credentials for your DNS provider
						and gets one wildcard certificate for the site and every preview name.{" "}
						<strong>HTTP-01</strong> needs port 80 open to the internet and gets a
						certificate for each preview name the first time it is opened. Tokens and
						keys are never shown again: each field says whether one is set, and leaving
						it blank keeps it.
					</p>
					<p>
						<strong>Test only</strong> checks that the names point at this server and
						gets a certificate without putting it in use: from Let's Encrypt staging, or
						a real one from ZeroSSL or another directory, which have no test service.{" "}
						<strong>Apply</strong> does the same, then switches the site once the new
						certificate exists. If it does not arrive, the previous settings are put
						back on their own. <strong>Roll back</strong> returns to the settings before
						the last change. Administrators get a notification 14 days before the
						certificate expires and when a renewal fails.
					</p>
				</>
			),
		},
		{
			id: "admin-docker",
			title: "Docker images and the pull cache",
			body: (
				<>
					<p>
						Workspaces pull Docker Hub images through a <strong>pull cache</strong> on
						this server, so an image one student pulled comes from here for the next,
						and the server stays under Docker Hub's limit on anonymous pulls. The{" "}
						<strong>Docker</strong> tab shows the space the cache uses on the{" "}
						<strong>Pull cache space</strong> meter, marked at 90 percent, where it
						empties itself. <strong>Clear cache</strong> empties it; images already in
						workspaces stay. If setup turned the cache off for lack of disk space, the
						tab says why; free space and run{" "}
						<code className="pk-mono-body">sudo dpkg-reconfigure portikus</code> to turn
						it back on. An optional <strong>Docker Hub account</strong>, given as a
						personal access token with the "Public Repo Read-only" scope, raises the
						limit. Every student can pull what that account can read, so use one with no
						private repositories. Saving or removing it empties the cache.
					</p>
					<p>
						The <strong>ghcr.io cache</strong> is on by default. Students build and push
						their images from GitHub Actions, which runs on GitHub's machines and pushes
						to the real ghcr.io with the repository's{" "}
						<code className="pk-mono-body">GITHUB_TOKEN</code>. In a workspace they only
						pull those images, through the cache, with no{" "}
						<code className="pk-mono-body">docker login</code>. While it is on, inside
						workspaces: <code className="pk-mono-body">docker push</code> to ghcr.io
						does not work, private ghcr.io images cannot be pulled (students make the
						package public), <code className="pk-mono-body">docker login ghcr.io</code>{" "}
						reports success without checking, and tools other than Docker, such as curl,
						gh and ORAS, get certificate errors for ghcr.io. Turn it off on the{" "}
						<strong>Docker</strong> tab; a change reaches each workspace when it next
						starts.
					</p>
					<p>
						For this, the server has its own certificate authority that may sign only
						ghcr.io. Only Docker inside workspaces trusts it; the workspace system,
						browsers and other tools do not, and its key never leaves the server.
					</p>
					<p>
						<strong>What saves disk and what saves bandwidth.</strong> The pull cache
						saves download bandwidth, pull time and the shared Docker Hub limit, not
						disk: every student who pulls an image still has a full unpacked copy in
						their own Docker storage. The cache is one fixed-size file on the server,
						sized at install (20 GiB by default) and reserved when created. The first
						fetch of an image downloads about twice its size; later pulls download
						almost nothing (measured: 88 MB, then 8 KB). The seed is what saves disk: a
						seed image is stored once and shared by every workspace made or reset from
						the seed, costing a student only what they change. For example, four images
						of 2.9 GB shared by 30 students instead of about 87 GB. Use{" "}
						<strong>Image use</strong> to move popular pulled images into the seed.
						Existing workspaces take a new seed only when the student uses Reset Docker;
						Docker storage is never swapped behind a student's back.
					</p>
					<p>
						The <strong>seed</strong> is a set of images that new workspaces, Reset
						Docker and a rebuild with Reset Docker start with. List the images and press{" "}
						<strong>Rebuild seed</strong>; the page shows each step. Existing Docker
						storage keeps what it has. <strong>Image use</strong> lists images
						workspaces used over the last 120 days that the seed does not hold, and seed
						images nobody used, so you can add or remove them. Every image row shows its{" "}
						<strong>Download size</strong>, or a dash when the cache never held it; the
						seed meter shows the seed's size on disk against its limit.
					</p>
					<p>
						A new install's seed list starts with the slim Node and Python images that
						match the default workspace image. Portikus never changes a list you have
						set or emptied. After the default image changes, the seed card may say the
						image runs a different Node or Python;{" "}
						<strong>Update list and rebuild</strong> swaps the old node and python slim
						images for the new ones and rebuilds the seed, unless the download would
						pass the seed's limit.
					</p>
				</>
			),
		},
		{
			id: "admin-settings",
			title: "Site settings",
			body: (
				<p>
					<strong>Settings</strong> holds the site-wide rules: when workspaces stop, how
					heavy use is slowed, and the acceptable-use statement. Saving a new statement
					asks everyone, you included, to accept it before they continue. Most rules can
					be changed for one workspace from its panel on <strong>Users</strong>.
				</p>
			),
		},
		{
			id: "admin-notifications",
			title: "Alerts",
			body: (
				<>
					<p>
						The <strong>Notifications</strong> section of <strong>Settings</strong>{" "}
						sends warnings and failures that need a person, and a Portikus service
						stopping, to email, Pushover, ntfy, Microsoft Teams or a webhook. The
						webhook also works for Slack, Mattermost, Google Chat and Discord. Email
						needs an SMTP server on port 587 or 465 and a list of recipients. Every
						other address must be an <code className="pk-mono-body">https://</code>{" "}
						address on port 443.
					</p>
					<p>
						Passwords, tokens and secret addresses are never shown again: each field
						says whether one is set, and leaving it blank keeps it. Changing a host
						clears the secret that went with it. Every change is audited and every
						administrator gets a notice. After saving, use each channel's{" "}
						<strong>Send test</strong> button to check it.{" "}
						<strong>Alert when a root shell opens</strong> is off unless you turn it on.
					</p>
				</>
			),
		},
		{
			id: "admin-shell",
			title: "Root shell",
			body: (
				<>
					<p>
						The <strong>Root shell</strong> tab opens a root shell on the server, in
						panes you can split and drag like workspace terminals. Nothing you type or
						see is recorded; opening and closing each shell is audited. Closing a pane,
						reloading the page or leaving the admin area ends its shell. Signing out,
						losing the administrator role or a disabled account ends every shell at
						once, including programs it left running.
					</p>
					<p>
						Restarting Portikus ends every root shell, so run{" "}
						<code className="pk-mono-body">apt upgrade</code> and other long jobs inside{" "}
						<code className="pk-mono-body">tmux</code>, which keeps running after the
						pane closes. The server's operator can turn root shells off; then this tab
						is hidden.
					</p>
				</>
			),
		},
		{
			id: "admin-roles",
			title: "Roles",
			body: (
				<p>
					Administrators and instructors come from your sign-in provider's groups, or
					are granted here with <strong>Promote</strong> and{" "}
					<strong>Make instructor</strong>. Only SSO accounts can be granted a role
					here; course accounts get theirs from the learning system. You can take away
					only a role that was granted here, and you cannot demote yourself. Instructors
					see a <strong>Course</strong> page for the courses they teach.
				</p>
			),
		},
		{
			id: "admin-privacy",
			title: "What administrators cannot see",
			body: (
				<p>
					You see a workspace's CPU, memory, disk, port numbers and short process names.
					You never see a student's files, terminals, commands or prompts, and Portikus
					does not record them.
				</p>
			),
		},
	],
};
