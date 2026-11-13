import type { AdminWorkspaceDetail } from "@portikus/contracts";
import { Toggletip } from "@portikus/ui";
import { shortTime } from "../../text.js";
import { TableBox } from "../TableBox.js";
import { PANEL_HELP, SECTION_HEADING } from "./shared.js";

export function PortsSection({ detail }: { detail: AdminWorkspaceDetail }) {
	return (
		<section aria-labelledby="detail-ports" className="pk-detail-section">
			<h4 id="detail-ports" className={SECTION_HEADING}>
				Ports and connections
			</h4>
			{detail.ports.length === 0 ? null : (
				<TableBox label="Listening ports">
					<table className="pk-table" data-testid="detail-ports">
						<caption className="sr-only">Listening ports</caption>
						<thead>
							<tr>
								<th scope="col" className="pk-num">
									Port
								</th>
								<th scope="col">Process</th>
								<th scope="col">
									<span className="inline-flex items-center gap-0.5">
										Preview
										<Toggletip label="Preview column">{PANEL_HELP.preview}</Toggletip>
									</span>
								</th>
							</tr>
						</thead>
						<tbody>
							{detail.ports.map((port) => (
								<tr key={port.port}>
									<td className="pk-num pk-mono-small">{port.port}</td>
									<td className="break-all">
										{port.command ?? "—"}
										{port.system ? <span className="pk-tag ml-1">System</span> : null}
									</td>
									<td>{port.previewReachability}</td>
								</tr>
							))}
						</tbody>
					</table>
				</TableBox>
			)}
			<p className="pk-text-compact m-0">
				{detail.ports.length === 0 ? (
					<span className="pk-muted">No listening ports. </span>
				) : null}
				<span data-testid="detail-sessions">
					{detail.previewSessions.length === 0
						? "No open preview sessions."
						: `Open preview sessions: ${detail.previewSessions
								.map(
									(session) =>
										`port ${session.port} since ${shortTime(session.openedAt)}`,
								)
								.join(", ")}.`}
				</span>
			</p>
		</section>
	);
}
