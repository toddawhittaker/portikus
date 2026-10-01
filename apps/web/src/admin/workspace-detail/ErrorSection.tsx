import type { AdminWorkspaceDetail } from "@portikus/contracts";
import { Button, useToast } from "@portikus/ui";
import { errorText } from "../../api/request.js";
import { useReprovision } from "../queries.js";
import { PANEL_HELP, SECTION_HEADING, WithTip } from "./shared.js";

export function ErrorSection({
	detail,
	ownerName,
	onReprovisioned,
}: {
	detail: AdminWorkspaceDetail;
	ownerName: string;
	onReprovisioned: () => void;
}) {
	const { workspace } = detail;
	const toast = useToast();
	const reprovision = useReprovision();
	if (!workspace.errorCode && !workspace.errorMessage) return null;

	function run() {
		if (reprovision.isPending) return;
		reprovision.mutate(
			{ workspaceId: workspace.id },
			{
				onSuccess: () => {
					toast.show({ tone: "success", title: "Re-provision requested" });
					// The section goes once the error clears, so focus moves to the panel heading.
					onReprovisioned();
				},
				onError: (error) =>
					toast.show({
						tone: "danger",
						title: "Could not re-provision the workspace",
						children: errorText(error),
					}),
			},
		);
	}

	return (
		<section aria-labelledby="detail-error" className="pk-detail-section">
			<h4 id="detail-error" className={SECTION_HEADING}>
				Error
			</h4>
			<p className="pk-text-compact m-0">
				{workspace.errorMessage ?? "The workspace reported an error."}
			</p>
			<dl className="pk-techdetail">
				<div>
					<dt className="inline">errorCode: </dt>
					<dd className="inline">{workspace.errorCode ?? "—"}</dd>
				</div>
				<div>
					<dt className="inline">errorMessage: </dt>
					<dd className="inline">{workspace.errorMessage ?? "—"}</dd>
				</div>
			</dl>
			{workspace.state === "error" ? (
				<div className="pk-actions">
					<WithTip label="Re-provision" tip={PANEL_HELP.reprovision}>
						<Button
							size="sm"
							data-testid="detail-reprovision"
							aria-label={`Re-provision ${ownerName}'s workspace`}
							loading={reprovision.isPending}
							onClick={run}
						>
							Re-provision
						</Button>
					</WithTip>
				</div>
			) : null}
		</section>
	);
}
