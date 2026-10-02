/**
 * The Running surface (SPEC.md §18.2, DESIGN.md "Running services"): one
 * row per listening port, with Open preview, Open in new tab and Stop for
 * the ports the student owns. It explains what is running; it does not
 * replace `ps` or `docker ps`.
 *
 * Listeners the agent attributes to the platform or a system account are
 * hidden behind a toggle, so a student sees their own Vite server and not
 * systemd-resolved. A port that stops listening leaves the
 * list. Selecting a row shows what holds it.
 */

import type { ListeningService, WorkspaceUsage } from "@portikus/contracts";
import {
	Button,
	Checkbox,
	ConfirmDialog,
	ConfirmDialogRoot,
	EmptyState,
	IconButton,
	Toggletip,
	useToast,
} from "@portikus/ui";
import { useState } from "react";
import { FullCommandButton, FullCommandText } from "../monitor/FullCommand.js";
import { formatBytes, formatCpu } from "../monitor/format.js";
import { useWorkspaceUsage } from "../monitor/usage.js";
import { openPreviewInNewTab } from "../preview/grants.js";
import "../preview/preview.css";
import { PORT_REFUSED_TEXT } from "../links.js";
import { PaneSplit } from "../shell/paneSplit.js";
import {
	isDocker,
	isPreviewable,
	readShowSystem,
	serviceCommand,
	serviceReason,
	stopListener,
	useListening,
	writeShowSystem,
} from "./services.js";

export interface RunningPaneProps {
	workspaceId: string;
	/** The port of the Preview tab in view, so its row can be marked current. */
	activePort: number | null;
	onOpenPreview: (port: number) => void;
}

export function RunningPane({
	workspaceId,
	activePort,
	onOpenPreview,
}: RunningPaneProps) {
	const listening = useListening();
	const toast = useToast();
	const [showSystem, setShowSystem] = useState(readShowSystem);
	const [stopping, setStopping] = useState<ListeningService | null>(null);
	const [selectedPort, setSelectedPort] = useState<number | null>(null);
	// Keyed by port and pid, so a new process on the same port starts collapsed.
	const [expandedRows, setExpandedRows] = useState<Set<string>>(() => new Set());

	function toggleCommand(key: string) {
		setExpandedRows((previous) => {
			const next = new Set(previous);
			if (next.has(key)) next.delete(key);
			else next.add(key);
			return next;
		});
	}

	const all = [...listening.services].sort((a, b) => a.port - b.port);
	const services = showSystem ? all : all.filter((service) => !service.system);
	const systemCount = all.filter((service) => service.system).length;
	// The panel only describes a row that is still on screen. A port that
	// stopped, or a system row the toggle just hid, closes it.
	const stillThere =
		selectedPort !== null && services.some((service) => service.port === selectedPort);
	if (selectedPort !== null && !stillThere) setSelectedPort(null);
	const selected = stillThere
		? services.find((service) => service.port === selectedPort)
		: undefined;
	// CPU and memory are only read while a row is selected.
	const usage = useWorkspaceUsage(workspaceId, selected !== undefined);

	async function openTab(port: number) {
		if (await openPreviewInNewTab(workspaceId, port)) return;
		toast.show({
			tone: "danger",
			title: "That preview could not be opened",
			children: "Check that your application is still running, then try again.",
		});
	}

	async function confirmStop(service: ListeningService) {
		setStopping(null);
		try {
			await stopListener(workspaceId, service.port);
		} catch {
			toast.show({
				tone: "danger",
				title: `Port ${service.port} did not stop`,
				children: "Try again, or end the process from a terminal.",
			});
		}
	}

	const list = (
		<div className="pk-pane-body pk-running-list" data-testid="running-list">
			{services.length === 0 ? (
				<EmptyState icon="play" title="Nothing is running yet">
					Start an application in a terminal and its port appears here.
				</EmptyState>
			) : null}

			{services.map((service) => {
				const reason = serviceReason(service);
				const command = serviceCommand(service);
				const isSelected = service.port === selected?.port;
				// The agent sends one only for the student's own listener (SPEC.md
				// §24.11); a system or Docker row never offers it, whatever arrives.
				const commandLine =
					service.system || isDocker(service)
						? undefined
						: service.process?.commandLine;
				const rowKey = `${service.port}:${service.process?.pid ?? ""}`;
				const expanded = commandLine !== undefined && expandedRows.has(rowKey);
				const detailId = `running-command-${service.port}`;
				return (
					<div
						key={service.port}
						className={[
							"pk-portrow",
							service.port === activePort ? "is-current" : "",
							isSelected ? "is-selected" : "",
						]
							.filter(Boolean)
							.join(" ")}
						data-testid={`running-row-${service.port}`}
					>
						<button
							type="button"
							className="pk-portrow-select"
							aria-expanded={isSelected}
							aria-current={service.port === activePort ? "true" : undefined}
							aria-controls={isSelected ? "running-details" : undefined}
							onClick={() => setSelectedPort(service.port)}
						>
							<span className="pk-portrow-port">{service.port}</span>
							<span className="pk-portrow-main">
								{/* The name truncates, so the full command is the tooltip. */}
								<span className="pk-portrow-name" title={command}>
									{command}
								</span>
								<RowTags service={service} reason={reason} />
							</span>
						</button>
						{expanded ? (
							<div className="pk-portrow-command">
								<FullCommandText id={detailId} commandLine={commandLine} />
							</div>
						) : null}
						<span className="pk-portrow-actions">
							{service.previewReachability === "denied" && !service.system ? (
								<Toggletip label={`Can't be previewed, port ${service.port}`}>
									{PORT_REFUSED_TEXT}
								</Toggletip>
							) : null}
							{commandLine !== undefined ? (
								<FullCommandButton
									subject={`port ${service.port}`}
									expanded={expanded}
									detailId={detailId}
									testId={`running-show-command-${service.port}`}
									onToggle={() => toggleCommand(rowKey)}
								/>
							) : null}
							{isPreviewable(service) && !service.system ? (
								<>
									<Button
										size="sm"
										aria-label={`Preview port ${service.port}`}
										data-testid={`running-open-${service.port}`}
										onClick={() => {
											setSelectedPort(service.port);
											onOpenPreview(service.port);
										}}
									>
										Preview
									</Button>
									<IconButton
										icon="external"
										label={`Open port ${service.port} in a new tab`}
										size="sm"
										data-testid={`running-new-tab-${service.port}`}
										onClick={() => {
											setSelectedPort(service.port);
											void openTab(service.port);
										}}
									/>
								</>
							) : null}
							{service.system ? null : (
								<IconButton
									icon="stop"
									label={`Stop port ${service.port}`}
									size="sm"
									className="pk-iconbtn-danger"
									data-testid={`running-stop-${service.port}`}
									onClick={() => {
										setSelectedPort(service.port);
										setStopping(service);
									}}
								/>
							)}
						</span>
					</div>
				);
			})}

			{stopping ? (
				<ConfirmDialogRoot open onOpenChange={(open) => !open && setStopping(null)}>
					<ConfirmDialog
						testId="dialog-stop-listener"
						title={stopTitle(stopping)}
						description={
							isDocker(stopping)
								? "The Docker container publishing this port is stopped."
								: "The process holding this port is asked to stop, and killed if it does not."
						}
						confirmLabel="Stop"
						onCancel={() => setStopping(null)}
						onConfirm={() => void confirmStop(stopping)}
					/>
				</ConfirmDialogRoot>
			) : null}
		</div>
	);

	return (
		<>
			<div className="pk-pane-head pk-pane-head--actions">
				<h2 className="sr-only">Running</h2>
				<span className="pk-pane-head-about">
					<Toggletip label="Running">
						Programs in your workspace that are listening on a port. Preview opens one
						here in a tab, and Open in new tab opens it in its own browser tab. Only you
						can open your previews, after signing in.
					</Toggletip>
				</span>
				{systemCount > 0 || showSystem ? (
					<>
						<span className="pk-running-toggle" data-testid="running-system-toggle">
							<Checkbox
								label="Show system"
								checked={showSystem}
								onChange={(event) => {
									setShowSystem(event.target.checked);
									writeShowSystem(event.target.checked);
								}}
							/>
						</span>
						<Toggletip label="Show system">
							Also list ports opened by the workspace system rather than by you. You
							usually do not need these.
						</Toggletip>
					</>
				) : null}
			</div>
			{selected ? (
				<PaneSplit
					storageKey="pk-running-details"
					label="Resize details"
					panel={<RunningDetails service={selected} usage={usage.data} />}
				>
					{list}
				</PaneSplit>
			) : (
				list
			)}
		</>
	);
}

/** The Docker tag and the reason a row cannot be previewed, when there are any. */
function RowTags({
	service,
	reason,
}: {
	service: ListeningService;
	reason: string | null;
}) {
	if (!isDocker(service) && reason === null) return null;
	return (
		<span className="pk-portrow-tags pk-text-caption">
			{isDocker(service) ? <span className="pk-portrow-kind">Docker</span> : null}
			{reason !== null ? (
				<span
					className="pk-portrow-kind"
					data-testid={`running-reason-${service.port}`}
				>
					{reason}
				</span>
			) : null}
		</span>
	);
}

/** The Stop dialog's question, naming the program when it is known. */
function stopTitle(service: ListeningService): string {
	const name = service.container?.name ?? service.process?.command;
	return name ? `Stop ${name} on port ${service.port}?` : `Stop port ${service.port}?`;
}

/** What is holding the selected port, including CPU and memory. */
function RunningDetails({
	service,
	usage,
}: {
	service: ListeningService;
	usage: WorkspaceUsage | undefined;
}) {
	const addresses =
		service.addresses.length > 0 ? service.addresses.join(", ") : "Not known";
	const pid = service.process?.pid;
	const process =
		pid === undefined ? undefined : usage?.processes.find((row) => row.pid === pid);
	// A sample that does not contain the pid means the process has exited.
	// Until the first sample arrives, the figures are simply not ready.
	const gone = usage !== undefined && pid !== undefined && process === undefined;
	return (
		<div
			className="pk-running-panel"
			id="running-details"
			data-testid="running-details"
		>
			<div className="pk-running-panel-head">Details</div>
			<dl className="pk-running-details">
				<dt>Port</dt>
				<dd>{service.port}</dd>
				<dt>Addresses</dt>
				<dd>{addresses}</dd>
				<dt>PID</dt>
				<dd>{pid ?? "Not known"}</dd>
				<dt>Command</dt>
				<dd>{service.process?.command ?? "Not known"}</dd>
				<dt>Command line</dt>
				<dd>{service.process?.commandLine ?? "Not known"}</dd>
				{gone ? (
					<>
						<dt>Process</dt>
						<dd data-testid="running-process-gone">
							This process is no longer running.
						</dd>
					</>
				) : (
					<>
						<dt>CPU</dt>
						<dd data-testid="running-cpu">
							{process ? formatCpu(process.cpuPercent) : "…"}
						</dd>
						<dt>Memory</dt>
						<dd data-testid="running-memory">
							{process ? formatBytes(process.residentBytes) : "…"}
						</dd>
					</>
				)}
			</dl>
		</div>
	);
}
