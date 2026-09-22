/**
 * The Running surface (SPEC.md §18.2, DESIGN.md "Running services"): one
 * row per listening port, with Open preview, Open in new tab and Stop for
 * the ports the student owns. It explains what is running; it does not
 * replace `ps` or `docker ps`.
 *
 * Listeners the agent attributes to the platform or a system account are
 * hidden behind a toggle, so a student sees their own Vite server and not
 * systemd-resolved (issue #265). A port that stops listening leaves the
 * list (issue #325). Selecting a row shows what holds it (issue #326).
 */

import type { ListeningService } from "@portikus/contracts";
import {
	ConfirmDialog,
	ConfirmDialogRoot,
	EmptyState,
	IconButton,
	useToast,
} from "@portikus/ui";
import { useState } from "react";
import { openPreviewInNewTab } from "../preview/grants.js";
import "../preview/preview.css";
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

	const all = [...listening.services].sort((a, b) => a.port - b.port);
	const services = showSystem ? all : all.filter((service) => !service.system);
	const systemCount = all.filter((service) => service.system).length;
	// The panel only describes a row that is still on screen. A port that
	// stopped, or a system row the toggle just hid, closes it (issue #326).
	const stillThere =
		selectedPort !== null && services.some((service) => service.port === selectedPort);
	if (selectedPort !== null && !stillThere) setSelectedPort(null);
	const selected = stillThere
		? services.find((service) => service.port === selectedPort)
		: undefined;

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

	return (
		<>
			<div className="pk-pane-body" data-testid="running-list">
				{services.length === 0 ? (
					<EmptyState icon="play" title="Nothing is running yet">
						Start an application in a terminal and its port appears here.
					</EmptyState>
				) : null}

				{services.map((service) => {
					const reason = serviceReason(service);
					const command = serviceCommand(service);
					const isSelected = service.port === selected?.port;
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
								aria-controls={isSelected ? "running-details" : undefined}
								onClick={() => setSelectedPort(service.port)}
							>
								<span className="pk-portrow-port">{service.port}</span>
								{/* The column truncates, so the full command is the tooltip. */}
								<span title={command}>{command}</span>
								{isDocker(service) ? (
									<span className="pk-portrow-kind">Docker</span>
								) : (
									<span />
								)}
							</button>
							<span className="pk-portrow-actions">
								{reason !== null ? (
									<span
										className="pk-portrow-kind"
										data-testid={`running-reason-${service.port}`}
									>
										{reason}
									</span>
								) : null}
								{isPreviewable(service) && !service.system ? (
									<>
										<IconButton
											icon="preview"
											label={`Open preview of port ${service.port}`}
											size="sm"
											data-testid={`running-open-${service.port}`}
											onClick={() => {
												setSelectedPort(service.port);
												onOpenPreview(service.port);
											}}
										/>
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
										className="pk-running-stop"
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

				{systemCount > 0 || showSystem ? (
					<label className="pk-running-toggle" data-testid="running-system-toggle">
						<input
							type="checkbox"
							checked={showSystem}
							onChange={(event) => {
								setShowSystem(event.target.checked);
								writeShowSystem(event.target.checked);
							}}
						/>
						Show system services
					</label>
				) : null}

				{stopping ? (
					<ConfirmDialogRoot open onOpenChange={(open) => !open && setStopping(null)}>
						<ConfirmDialog
							testId="dialog-stop-listener"
							title={`Stop ${serviceCommand(stopping)} on port ${stopping.port}?`}
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

			{selected ? <RunningDetails service={selected} /> : null}
		</>
	);
}

/** What is holding the selected port (issue #326). */
function RunningDetails({ service }: { service: ListeningService }) {
	const addresses =
		service.addresses.length > 0 ? service.addresses.join(", ") : "unknown";
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
				<dd>{service.process?.pid ?? "unknown"}</dd>
				<dt>Command</dt>
				<dd>{service.process?.command ?? "unknown"}</dd>
				<dt>Command line</dt>
				<dd>{service.process?.commandLine ?? "unknown"}</dd>
			</dl>
		</div>
	);
}
