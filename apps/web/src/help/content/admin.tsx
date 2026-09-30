import type { HelpPart } from "./part.js";

/**
 * For administrators. Each admin tab's intro links to one of these anchors
 * ("More in Help"), so keep the ids stable: admin-users, admin-health,
 * admin-logs, admin-audit, admin-network, admin-backups, admin-image, admin-docker,
 * admin-settings.
 */
export const ADMIN_HELP: HelpPart = {
	id: "admin",
	title: "For administrators",
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
					state and storage, and every action for it.
				</p>
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
						host with today's Debian packages and the latest Claude Code and Codex, and
						lets you pick Node 24 or 26 and whether to add Python 3.14. A rebuild takes
						about 20 minutes. The page shows each step and the log while the job runs.
					</p>
					<p>
						Each new image gets a health check, and you see what changed against the
						default. Only an image that passed can be made the default. The old default
						becomes the previous image, and <strong>Roll back</strong> swaps them again.
						Existing workspaces keep the image they were made from until you rebuild
						each one; the list shows how many workspaces run each image.
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
						<strong>Docker</strong> tab shows the space the cache uses.{" "}
						<strong>Clear cache</strong> empties it; images already in workspaces stay.
						An optional <strong>Docker Hub account</strong>, given as a personal access
						token with the "Public Repo Read-only" scope, raises the limit. Every
						student can pull what that account can read, so use one with no private
						repositories. Saving or removing it empties the cache.
					</p>
					<p>
						The <strong>ghcr.io cache</strong> is off by default. While it is on,
						workspaces cannot push to ghcr.io, cannot pull private ghcr.io images, and
						tools other than Docker that talk to ghcr.io do not work.
					</p>
					<p>
						The <strong>seed</strong> is a set of images that new workspaces, Reset
						Docker and a rebuild with Reset Docker start with. List the images and press{" "}
						<strong>Rebuild seed</strong>; the page shows each step. Existing Docker
						storage keeps what it has. <strong>Image use</strong> lists images
						workspaces used that the seed does not hold, and seed images nobody used, so
						you can add or remove them.
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
