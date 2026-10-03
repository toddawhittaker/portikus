import type { BackupRequestView, BackupWorkspace } from "@portikus/contracts";
import { Button, Toggletip } from "@portikus/ui";
import type { ReactNode } from "react";
import {
	isWaiting,
	longTime,
	requestText,
	setTime,
	stateText,
	workspaceName,
} from "./model.js";
import { Group, Part, Table } from "./parts.js";

/** How many recent requests the page lists; the API keeps 50. */
const RECENT_SHOWN = 10;

const REPLACE_HELP = (
	<Toggletip label="Replace home">
		Replace home swaps the student's whole home folder for the one in the same backup
		set. You confirm by typing the workspace label. Their current home is kept, and
		listed under Clean up until you delete it.
	</Toggletip>
);

type Props = {
	requests: BackupRequestView[];
	workspaces: BackupWorkspace[];
	onReplace: (restore: BackupRequestView) => void;
};

/**
 * Restores and Recent requests. With no requests at all both lists are empty,
 * so they share one Activity group instead of two cards that each say so.
 */
export function ActivityGroups({ requests, workspaces, onReplace }: Props) {
	if (requests.length === 0) {
		return (
			<Group id="backups-activity-title" title="Activity" testId="backups-activity">
				<Part id="backups-restores-title" title="Restores" help={REPLACE_HELP}>
					<RestoresTable
						requests={requests}
						workspaces={workspaces}
						onReplace={onReplace}
					/>
				</Part>
				<Part id="backups-recent-title" title="Recent requests">
					<RecentTable requests={requests} workspaces={workspaces} />
				</Part>
			</Group>
		);
	}
	return (
		<>
			<Group
				id="backups-restores-title"
				title="Restores"
				help={REPLACE_HELP}
				description="Each restored copy sits next to the student's files. To swap their whole home folder for the one in the same backup set, choose Replace home."
				testId="backups-restores"
			>
				<RestoresTable
					requests={requests}
					workspaces={workspaces}
					onReplace={onReplace}
				/>
			</Group>
			<Group id="backups-recent-title" title="Recent requests">
				<RecentTable requests={requests} workspaces={workspaces} />
			</Group>
		</>
	);
}

function copyState(request: BackupRequestView): ReactNode {
	if (request.state === "failed") {
		return (
			<span>
				<span className="pk-tag pk-tag--error">Failed</span>{" "}
				<span className="whitespace-normal">{request.error}</span>
			</span>
		);
	}
	if (request.state === "done") return "Copied";
	return request.state === "claimed" ? "Copying" : "Waiting for the host";
}

function RestoresTable({ requests, workspaces, onReplace }: Props) {
	const copies = requests.filter((r) => r.kind === "restore_copy");
	return (
		<Table
			testId="backup-copies"
			caption="Workspaces restored into a side copy, newest first"
			headers={["Workspace", "From backup", "Folder", "State", ""]}
			empty={copies.length === 0 ? "No workspaces restored recently." : null}
		>
			{copies.map((copy) => {
				const name = workspaceName(copy.args.instance, workspaces);
				const replaceable =
					copy.state === "done" && workspaces.some((w) => w.id === copy.workspaceId);
				return (
					<tr key={copy.id} data-testid="backup-copy">
						<th scope="row">{name}</th>
						<td>{copy.args.stamp ? setTime(copy.args.stamp) : ""}</td>
						<td className="font-mono">~/{copy.args.dir}</td>
						<td>{copyState(copy)}</td>
						<td className="pk-cell-actions">
							{replaceable ? (
								<Button
									size="sm"
									data-testid="backup-copy-replace"
									aria-label={`Replace home for ${name}`}
									onClick={() => onReplace(copy)}
								>
									Replace home…
								</Button>
							) : null}
						</td>
					</tr>
				);
			})}
		</Table>
	);
}

function RecentTable({
	requests,
	workspaces,
}: {
	requests: BackupRequestView[];
	workspaces: BackupWorkspace[];
}) {
	const shown = requests.slice(0, RECENT_SHOWN);
	return (
		<Table
			testId="backup-requests"
			caption="Recent backup requests, newest first"
			headers={["Request", "Asked", "State"]}
			empty={shown.length === 0 ? "No requests yet." : null}
		>
			{shown.map((request) => (
				<tr key={request.id} data-testid="backup-request">
					<th scope="row" className="whitespace-normal">
						{requestText(request, workspaces)}
					</th>
					<td>{longTime(request.requestedAt)}</td>
					<td className="whitespace-normal">
						{request.state === "failed" ? (
							<>
								<span className="pk-tag pk-tag--error">Failed</span> {request.error}
							</>
						) : (
							<span className={isWaiting(request) ? "pk-muted" : undefined}>
								{stateText(request)}
							</span>
						)}
					</td>
				</tr>
			))}
		</Table>
	);
}
