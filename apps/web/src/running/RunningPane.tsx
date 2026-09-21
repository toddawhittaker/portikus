/**
 * The Running surface (SPEC.md §18.2, DESIGN.md "Running services"): one
 * row per listening port, with Open preview, Open in new tab and Stop for
 * the ports the student owns. It explains what is running; it does not
 * replace `ps` or `docker ps`.
 *
 * Listeners the agent attributes to the platform or a system account are
 * hidden behind a toggle, so a student sees their own Vite server and not
 * systemd-resolved (issue #265).
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
	/** Ports that have a saved preview tab, so a stale one can be marked. */
	previewPorts: number[];
	/** The port of the Preview tab in view, so its row can be marked current. */
	activePort: number | null;
	onOpenPreview: (port: number) => void;
}

export function RunningPane({
	workspaceId,
	previewPorts,
	activePort,
	onOpenPreview,
}: RunningPaneProps) {
	const listening = useListening();
	const toast = useToast();
	const [showSystem, setShowSystem] = useState(readShowSystem);
	const [stopping, setStopping] = useState<ListeningService | null>(null);

	const all = [...listening.services].sort((a, b) => a.port - b.port);
	const services = showSystem ? all : all.filter((service) => !service.system);
	const systemCount = all.filter((service) => service.system).length;
	const live = new Set(all.map((service) => service.port));
	// A preview tab whose port stopped listening is said so here, rather than
	// leaving the student to guess (SPEC.md §18.2).
	const stale = previewPorts.filter((port) => !live.has(port)).sort((a, b) => a - b);

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
		<div className="pk-pane-body" data-testid="running-list">
			{services.length === 0 && stale.length === 0 ? (
				<EmptyState icon="play" title="Nothing is running yet">
					Start an application in a terminal and its port appears here.
				</EmptyState>
			) : null}

			{services.map((service) => {
				const reason = serviceReason(service);
				return (
					<div
						key={service.port}
						className={
							service.port === activePort ? "pk-portrow is-current" : "pk-portrow"
						}
						data-testid={`running-row-${service.port}`}
					>
						<span className="pk-portrow-port">{service.port}</span>
						{/* The column truncates, so the full command is the tooltip. */}
						<span title={serviceCommand(service)}>{serviceCommand(service)}</span>
						{isDocker(service) ? (
							<span className="pk-portrow-kind">Docker</span>
						) : (
							<span />
						)}
						{/* running/*.css owns this cell's layout; it borrows pk-portrow-kind. */}
						<span className="pk-portrow-kind">
							{reason !== null ? (
								<span data-testid={`running-reason-${service.port}`}>{reason}</span>
							) : null}
							{isPreviewable(service) && !service.system ? (
								<>
									<button
										type="button"
										className="pk-preview-action"
										data-testid={`running-open-${service.port}`}
										onClick={() => onOpenPreview(service.port)}
									>
										Open preview
									</button>
									<IconButton
										icon="external"
										label={`Open port ${service.port} in a new tab`}
										size="sm"
										data-testid={`running-new-tab-${service.port}`}
										onClick={() => void openTab(service.port)}
									/>
								</>
							) : null}
							{service.system ? null : (
								<button
									type="button"
									className="pk-preview-action"
									data-testid={`running-stop-${service.port}`}
									onClick={() => setStopping(service)}
								>
									Stop
								</button>
							)}
						</span>
					</div>
				);
			})}

			{stale.map((port) => (
				<div key={port} className="pk-portrow" data-testid={`running-stale-${port}`}>
					<span className="pk-portrow-port">{port}</span>
					<span className="pk-portrow-kind">not running</span>
					<span />
					<span />
				</div>
			))}

			{systemCount > 0 || showSystem ? (
				// running/*.css owns this row's own styling; it borrows pk-portrow.
				<label className="pk-portrow" data-testid="running-system-toggle">
					<input
						type="checkbox"
						checked={showSystem}
						onChange={(event) => {
							setShowSystem(event.target.checked);
							writeShowSystem(event.target.checked);
						}}
					/>
					<span className="pk-portrow-kind">Show system services</span>
					<span />
					<span />
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
	);
}
