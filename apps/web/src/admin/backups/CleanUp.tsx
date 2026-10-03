import type { AdminBackups, BackupRequestView } from "@portikus/contracts";
import { Button, Icon, Toggletip } from "@portikus/ui";
import { useRef, useState } from "react";
import { formatBytes } from "../../monitor/format.js";
import { plural } from "../../text.js";
import type { DeleteTarget } from "./BackupDialogs.js";
import { longTime, waitingRequest, workspaceName } from "./model.js";
import { FocusCatchGroup, Table, useFocusCatch } from "./parts.js";
import type { Host } from "./StatusAndSets.js";

/**
 * Snapshots, kept homes and dumps, which only need a look now and then, so the
 * group is closed while all three are empty.
 */
export function CleanUpGroup({
	data,
	host,
	onDelete,
}: {
	data: AdminBackups;
	host: Host;
	onDelete: (target: DeleteTarget) => void;
}) {
	const { vm } = data;
	const dumps = plural(host.dumps.length, "dump");
	const summary = vm
		? `${plural(vm.snapshots.length, "snapshot")}, ${plural(vm.keptHomes.length, "kept home")}, ${dumps}`
		: `${dumps}; snapshots and kept homes not listed yet`;
	const anything =
		host.dumps.length > 0 ||
		(vm !== null && vm.snapshots.length + vm.keptHomes.length > 0);
	// Opened once from what is there; after that the admin's toggle stands.
	const [open] = useState(anything);
	const summaryRef = useRef<HTMLElement>(null);
	const onFocus = useFocusCatch(() => summaryRef.current);
	return (
		<section
			className="pk-card p-6"
			aria-labelledby="backups-cleanup-title"
			data-testid="backups-cleanup"
			onFocus={onFocus}
		>
			<details className="group" open={open}>
				{/* A flex summary loses the browser's marker, so it draws the system chevron. */}
				<summary
					ref={summaryRef}
					className="pk-focus-ring flex w-fit cursor-pointer list-none items-baseline gap-3 rounded-xs [&::-webkit-details-marker]:hidden"
					data-testid="backups-cleanup-summary"
				>
					<h3 className="pk-text-heading m-0" id="backups-cleanup-title">
						<Icon
							name="chevron-right"
							size="md"
							className="me-1 inline align-[-0.2em] group-open:rotate-90"
						/>
						Clean up
					</h3>{" "}
					<span
						className="text-[13px] text-ink-muted"
						data-testid="backups-cleanup-count"
					>
						{summary}
					</span>
				</summary>
				<div className="mt-6 grid gap-6">
					<VmParts data={data} onDelete={onDelete} />
					<DumpsPart host={host} requests={data.requests} onDelete={onDelete} />
				</div>
			</details>
		</section>
	);
}

function VmParts({
	data,
	onDelete,
}: {
	data: AdminBackups;
	onDelete: (target: DeleteTarget) => void;
}) {
	const { vm, requests, workspaces } = data;
	const notListed = vm === null ? "Not listed yet." : null;
	return (
		<>
			<FocusCatchGroup
				level={4}
				id="backups-snapshots-title"
				title="Pre-change snapshots"
				help={
					<Toggletip label="pre-change snapshots">
						Snapshots of workspace volumes, named pre-something, that the operator takes
						before a risky change such as a rebuild on a new image. Nothing deletes them
						on its own. Delete them once the change checks out.
					</Toggletip>
				}
			>
				<Table
					testId="backup-snapshots"
					caption="Pre-change snapshots of workspace volumes"
					headers={["Volume", "Snapshot", "Taken", ""]}
					empty={
						notListed ?? (vm?.snapshots.length ? null : "No pre-change snapshots.")
					}
				>
					{vm?.snapshots.map((snap) => {
						const deleting = waitingRequest(requests, "delete_snapshot", {
							volume: snap.volume,
							snapshot: snap.name,
						});
						return (
							<tr key={`${snap.volume}/${snap.name}`} data-testid="backup-snapshot">
								<td className="font-mono">{snap.volume}</td>
								<th scope="row" className="font-mono">
									{snap.name}
								</th>
								<td>{longTime(snap.createdAt)}</td>
								<td className="pk-cell-actions">
									<Button
										size="sm"
										data-testid="backup-snapshot-delete"
										aria-label={
											deleting
												? `Deleting snapshot ${snap.name} of ${snap.volume}`
												: `Delete snapshot ${snap.name} of ${snap.volume}`
										}
										aria-disabled={deleting ? true : undefined}
										onClick={() => {
											if (!deleting)
												onDelete({
													kind: "snapshot",
													volume: snap.volume,
													snapshot: snap.name,
												});
										}}
									>
										{deleting ? "Deleting…" : "Delete…"}
									</Button>
								</td>
							</tr>
						);
					})}
				</Table>
			</FocusCatchGroup>
			<FocusCatchGroup
				level={4}
				id="backups-kept-title"
				title="Kept homes"
				help={
					<Toggletip label="kept homes">
						A student's previous home folder, set aside when Replace home swapped it
						out. Delete it once they confirm the restored home is right.
					</Toggletip>
				}
			>
				<Table
					testId="backup-kept-homes"
					caption="Home folders a replace took out of service"
					headers={["Workspace", "Kept since", ""]}
					empty={notListed ?? (vm?.keptHomes.length ? null : "No kept homes.")}
				>
					{vm?.keptHomes.map((kept) => {
						const name = workspaceName(kept.instance, workspaces);
						const deleting = waitingRequest(requests, "delete_kept_home", {
							volume: kept.volume,
						});
						return (
							<tr key={kept.volume} data-testid="backup-kept-home">
								<th scope="row">
									<span className="pk-cell-stack">
										<span>{name}</span>
										<span className="pk-muted font-mono text-[12px]">
											{kept.volume}
										</span>
									</span>
								</th>
								<td>{longTime(kept.createdAt)}</td>
								<td className="pk-cell-actions">
									<Button
										size="sm"
										data-testid="backup-kept-home-delete"
										aria-label={
											deleting
												? `Deleting the kept home of ${name}`
												: `Delete the kept home of ${name}`
										}
										aria-disabled={deleting ? true : undefined}
										onClick={() => {
											if (!deleting)
												onDelete({ kind: "kept", volume: kept.volume, name });
										}}
									>
										{deleting ? "Deleting…" : "Delete…"}
									</Button>
								</td>
							</tr>
						);
					})}
				</Table>
			</FocusCatchGroup>
		</>
	);
}

function DumpsPart({
	host,
	requests,
	onDelete,
}: {
	host: Host;
	requests: BackupRequestView[];
	onDelete: (target: DeleteTarget) => void;
}) {
	return (
		<FocusCatchGroup
			level={4}
			id="backups-dumps-title"
			title="Pre-change database dumps"
			help={
				<Toggletip label="pre-change database dumps">
					Copies of the platform database that the operator saves on the backup host
					before each deploy or other change. Delete them once the change has settled.
				</Toggletip>
			}
		>
			<Table
				testId="backup-dumps"
				caption="Pre-change database dumps on the host"
				headers={["File", "Size", "Taken", ""]}
				empty={host.dumps.length === 0 ? "No pre-change dumps." : null}
			>
				{host.dumps.map((dump) => {
					const deleting = waitingRequest(requests, "delete_dump", { file: dump.file });
					return (
						<tr key={dump.file} data-testid="backup-dump">
							<th scope="row" className="font-mono">
								{dump.file}
							</th>
							<td className="tabular-nums">{formatBytes(dump.sizeBytes)}</td>
							<td>{longTime(dump.modifiedAt)}</td>
							<td className="pk-cell-actions">
								<Button
									size="sm"
									data-testid="backup-dump-delete"
									aria-label={
										deleting ? `Deleting ${dump.file}` : `Delete ${dump.file}`
									}
									aria-disabled={deleting ? true : undefined}
									onClick={() => {
										if (!deleting) onDelete({ kind: "dump", file: dump.file });
									}}
								>
									{deleting ? "Deleting…" : "Delete…"}
								</Button>
							</td>
						</tr>
					);
				})}
			</Table>
		</FocusCatchGroup>
	);
}
