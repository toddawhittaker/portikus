import type { AdminUser } from "@portikus/contracts";
import { IconButton } from "@portikus/ui";
import { useEffect, useRef } from "react";
import { errorText } from "../api/request.js";
import { ProcessesSection } from "./ProcessesSection.js";
import { useAdminWorkspace } from "./queries.js";
import { AccountSection } from "./workspace-detail/AccountSection.js";
import { AuditSection } from "./workspace-detail/AuditSection.js";
import { ErrorSection } from "./workspace-detail/ErrorSection.js";
import { GuardSection } from "./workspace-detail/GuardSection.js";
import { HeadState } from "./workspace-detail/HeadState.js";
import { PortsSection } from "./workspace-detail/PortsSection.js";
import { ResourcesSection } from "./workspace-detail/ResourcesSection.js";
import { WorkspaceSection } from "./workspace-detail/WorkspaceSection.js";

/** The panel beside the table for one account and its workspace (SPEC.md §20.1). */
export function WorkspaceDetail({
	user,
	isSelf,
	onClose,
}: {
	user: AdminUser;
	isSelf: boolean;
	onClose: () => void;
}) {
	const workspaceId = user.workspace?.id ?? null;
	const detail = useAdminWorkspace(workspaceId);
	const data = detail.data ?? null;
	const headingRef = useRef<HTMLHeadingElement>(null);
	const userId = user.id;
	// Sections that need the detail wait for it; an account without a workspace has none to wait for.
	const settled = data !== null || workspaceId === null;

	// Opening a panel moves focus to its heading so the change is announced.
	useEffect(() => {
		if (userId) headingRef.current?.focus();
	}, [userId]);

	return (
		<section
			id="workspace-detail"
			// Sticks against the scrolling <main>: the window less the 48 px .pk-appbar and main's 32 px bottom padding.
			className="pk-card sticky top-0 flex max-h-[calc(100vh-80px)] w-[400px] flex-none flex-col self-start overflow-auto"
			aria-labelledby="detail-title"
			data-testid="workspace-detail"
		>
			<div className="pk-detail-head">
				<div className="flex min-w-0 flex-col gap-2">
					<div className="flex min-w-0 flex-col gap-0.5">
						<h3
							id="detail-title"
							ref={headingRef}
							tabIndex={-1}
							className="pk-text-heading m-0 break-words outline-none"
						>
							{user.displayName}
						</h3>
						{user.workspace ? (
							<span className="pk-mono-small pk-muted break-all">
								{user.workspace.label}
							</span>
						) : null}
					</div>
					{data ? <HeadState detail={data} ownerName={user.displayName} /> : null}
				</div>
				<IconButton
					icon="x"
					size="sm"
					label={`Close details for ${user.displayName}`}
					onClick={onClose}
				/>
			</div>
			{settled ? null : (
				<div className="pk-detail-section">
					{detail.isError ? (
						<p className="m-0 text-status-error" role="alert">
							{errorText(detail.error)}
						</p>
					) : (
						<p className="pk-text-compact pk-muted m-0" aria-busy="true">
							Loading…
						</p>
					)}
				</div>
			)}
			{data ? (
				<ErrorSection
					detail={data}
					ownerName={user.displayName}
					onReprovisioned={() => headingRef.current?.focus()}
				/>
			) : null}
			{settled ? (
				<>
					<WorkspaceSection detail={data} ownerName={user.displayName} />
					<ResourcesSection detail={data} user={user} />
				</>
			) : null}
			{data ? (
				<>
					<GuardSection detail={data} ownerName={user.displayName} />
					<ProcessesSection
						key={data.workspace.id}
						workspaceId={data.workspace.id}
						running={data.workspace.state === "running"}
						ownerName={user.displayName}
					/>
					<PortsSection detail={data} />
				</>
			) : null}
			<AccountSection user={user} isSelf={isSelf} />
			{data ? <AuditSection detail={data} /> : null}
		</section>
	);
}
