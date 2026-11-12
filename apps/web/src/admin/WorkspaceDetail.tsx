import type { AdminUser } from "@portikus/contracts";
import {
	Icon,
	IconButton,
	TabsContent,
	TabsList,
	TabsRoot,
	TabsTrigger,
} from "@portikus/ui";
import { useCallback, useEffect, useRef, useState } from "react";
import "../shell/right-pane.css";
import { errorText } from "../api/request.js";
import { ProcessesSection } from "./ProcessesSection.js";
import { useAdminWorkspace } from "./queries.js";
import { AccountSection } from "./workspace-detail/AccountSection.js";
import { AgentLogSection } from "./workspace-detail/AgentLogSection.js";
import { AuditSection } from "./workspace-detail/AuditSection.js";
import { ErrorSection } from "./workspace-detail/ErrorSection.js";
import { GuardSection } from "./workspace-detail/GuardSection.js";
import { HeadState } from "./workspace-detail/HeadState.js";
import { PortsSection } from "./workspace-detail/PortsSection.js";
import { ResourcesSection } from "./workspace-detail/ResourcesSection.js";
import {
	DestructiveSection,
	WorkspaceSection,
} from "./workspace-detail/WorkspaceSection.js";

type InspectorTab = "overview" | "activity" | "account";

const INSPECTOR_TABS: readonly {
	id: InspectorTab;
	label: string;
	icon: "activity" | "list" | "users";
}[] = [
	{ id: "overview", label: "Overview", icon: "activity" },
	{ id: "activity", label: "Activity", icon: "list" },
	{ id: "account", label: "Account", icon: "users" },
];

/** A throttle or memory flag is what the reader came for, so the guard then leads the Overview. */
export function overviewOrder(problem: boolean): ("guard" | "resources")[] {
	return problem ? ["guard", "resources"] : ["resources", "guard"];
}

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
	const problem =
		data !== null && (data.cpuThrottle !== null || data.memoryFlag !== null);

	const [tab, setTab] = useState<InspectorTab>("overview");
	const focusHeading = useCallback(() => headingRef.current?.focus(), []);
	// The head stays pinned while the panel scrolls; a control Tab reaches is
	// kept below it, however tall the head grows (WCAG 2.4.11).
	const headRef = useRef<HTMLDivElement>(null);
	const [headHeight, setHeadHeight] = useState(0);
	useEffect(() => {
		const head = headRef.current;
		if (!head || typeof ResizeObserver === "undefined") return;
		const observer = new ResizeObserver(() => setHeadHeight(head.offsetHeight));
		observer.observe(head);
		return () => observer.disconnect();
	}, []);
	// Opening a panel moves focus to its heading so the change is announced, on its first tab.
	useEffect(() => {
		if (!userId) return;
		setTab("overview");
		headingRef.current?.focus();
	}, [userId]);

	return (
		<section
			id="workspace-detail"
			// Beside the table it sticks against the framed, scrolling <main>, capped to what it shows less the content's padding above and below.
			className="pk-card flex flex-col @4xl:sticky @4xl:top-0 @4xl:max-h-[calc(100cqh-3rem)] @4xl:w-[400px] @4xl:flex-none @4xl:self-start @4xl:overflow-auto"
			aria-labelledby="detail-title"
			data-testid="workspace-detail"
			style={{ scrollPaddingTop: headHeight }}
		>
			{/* Stays in view while the panel scrolls, with the lifecycle actions. */}
			<div
				ref={headRef}
				className="pk-detail-head sticky top-0 z-[1] bg-surface-raised shadow-[0_1px_0_var(--line)]"
			>
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
					{data ? (
						<HeadState
							detail={data}
							ownerName={user.displayName}
							onFocusLost={focusHeading}
						/>
					) : null}
				</div>
				<IconButton
					icon="x"
					size="sm"
					label={`Close details for ${user.displayName}`}
					onClick={onClose}
				/>
			</div>
			<TabsRoot
				value={tab}
				onValueChange={(value) => setTab(value as InspectorTab)}
				className="flex min-h-0 flex-col"
			>
				<TabsList
					className="pk-pane-tabs pk-inspector-tabs"
					aria-label="Workspace details"
				>
					{INSPECTOR_TABS.map((item) => (
						<TabsTrigger
							key={item.id}
							value={item.id}
							className="pk-pane-tab"
							data-testid={`detail-tab-${item.id}`}
						>
							<span className="pk-pane-tab-face">
								<Icon name={item.icon} />
								<span className="pk-pane-tab-label">{item.label}</span>
								{item.id === "overview" && problem ? (
									<span
										className="pk-inspector-tab-mark"
										aria-label="needs attention"
										role="img"
									/>
								) : null}
							</span>
						</TabsTrigger>
					))}
				</TabsList>
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
				{/* Every part stays mounted, so a reading or an edit in progress survives a tab switch. */}
				<TabsContent value="overview" forceMount={true} className="pk-inspector-panel">
					{data ? (
						<ErrorSection
							detail={data}
							ownerName={user.displayName}
							onReprovisioned={() => headingRef.current?.focus()}
						/>
					) : null}
					{/*
					 * One keyed list, so when a flag comes or goes the guard moves rather
					 * than mounting again: its state and any open dialog survive, and the
					 * order on screen stays the order the keyboard follows.
					 */}
					{overviewOrder(problem).map((part) =>
						part === "guard" ? (
							data ? (
								<GuardSection key="guard" detail={data} ownerName={user.displayName} />
							) : null
						) : settled ? (
							<ResourcesSection key="resources" detail={data} user={user} />
						) : null,
					)}
					{settled ? (
						<WorkspaceSection detail={data} ownerName={user.displayName} />
					) : null}
				</TabsContent>
				<TabsContent value="activity" forceMount={true} className="pk-inspector-panel">
					{data ? (
						<>
							<ProcessesSection
								key={data.workspace.id}
								workspaceId={data.workspace.id}
								running={data.workspace.state === "running"}
								ownerName={user.displayName}
							/>
							<PortsSection detail={data} />
							<AgentLogSection
								key={`agent-log-${data.workspace.id}`}
								workspaceId={data.workspace.id}
								running={data.workspace.state === "running"}
							/>
							<AuditSection detail={data} />
						</>
					) : (
						<div className="pk-detail-section">
							<p className="pk-muted m-0 text-[13px]">
								No workspace, so nothing runs for this account.
							</p>
						</div>
					)}
				</TabsContent>
				<TabsContent value="account" forceMount={true} className="pk-inspector-panel">
					<AccountSection user={user} isSelf={isSelf} />
					{data ? (
						<DestructiveSection detail={data} ownerName={user.displayName} />
					) : null}
				</TabsContent>
			</TabsRoot>
		</section>
	);
}
