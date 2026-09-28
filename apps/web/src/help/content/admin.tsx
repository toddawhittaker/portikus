import type { HelpPart } from "./part.js";

/**
 * For administrators. Each admin tab's intro links to one of these anchors
 * ("More in Help"), so keep the ids stable: admin-users, admin-health,
 * admin-logs, admin-audit, admin-network, admin-backups, admin-settings.
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
					only grow. <strong>Limits</strong> sets the most CPU, memory and processes one
					workspace may use; a blank field uses the site value.
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
					hosts and ranges you list. Private networks are always blocked. Use{" "}
					<strong>Test a host</strong> to see why a name would be allowed or refused.{" "}
					<strong>Refused names</strong> shows what workspaces tried and failed to reach
					over the last 7 days, for the whole site, never per student.
				</p>
			),
		},
		{
			id: "admin-backups",
			title: "Backups and restores",
			body: (
				<>
					<p>
						The backup host copies the platform database and every workspace's home and
						recovery points each night. Docker data is not backed up, because Reset
						Docker and Rebuild recreate it. A site installed on one machine with no
						separate backup host has no backups, and the tab says so.
					</p>
					<p>
						To restore someone's files, choose <strong>Restore from backup</strong> in
						their panel, or <strong>Restore</strong> beside a set on{" "}
						<strong>Backups</strong>. The files arrive in a new folder in their home,
						next to their current files; nothing is overwritten. If they need their
						whole home back, choose <strong>Replace home</strong> on the restored copy
						and type their workspace label to confirm. Their current home is kept, under
						Kept homes, until you delete it.
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
					workspaces and settings, and who made it.
				</p>
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
					<strong>Make instructor</strong>. Only SSO accounts can be granted a role,
					never course accounts. You can take away only a role that was granted here,
					and you cannot demote yourself. Instructors see a <strong>Course</strong> page
					for the courses they teach.
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
