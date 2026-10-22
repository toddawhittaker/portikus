import { AdminSection } from "./AdminSection.js";
import { longTime } from "./backups/model.js";
import { MailSection } from "./notifications/MailSection.js";
import { usePlatformSettings } from "./queries.js";
import { AupSection } from "./settings/AupSection.js";
import { GuardSection, StopSection } from "./settings/NumberSections.js";
import { SectionIndex } from "./settings/SectionIndex.js";
import { ToolsSection } from "./settings/ToolsSection.js";
import { UnsavedChanges } from "./settings/unsaved.js";

/**
 * The platform-wide settings (SPEC.md section 20.1): when workspaces stop
 * (section 6.4), the resource guard (section 19.4), what students get in the
 * editor (sections 13.6 and 25.10), the acceptable-use statement (ADR 0032),
 * and mail and alerts (ADR 0052). Each section saves on its own, and nothing
 * saves on a click; leaving with unsaved changes asks first. The log level
 * lives on the Logs tab.
 */
export function SettingsTab() {
	return (
		<AdminSection
			title="Settings"
			intro={{
				id: "admin-settings",
				helpAnchor: "admin-settings",
				text: "Rules that apply to the whole site. Each section saves on its own, with its own button. Settings marked as changeable for one workspace are changed from that workspace's panel on the Users tab.",
			}}
		>
			<LastChanged />
			<UnsavedChanges>
				<div className="@container/settings">
					<div className="grid grid-cols-[minmax(0,1fr)] gap-4 @min-[62rem]/settings:grid-cols-[11rem_minmax(0,58rem)] @min-[62rem]/settings:gap-6">
						<SectionIndex />
						<div
							className="grid min-w-0 max-w-[58rem] gap-4"
							data-testid="settings-sections"
						>
							<StopSection />
							<GuardSection />
							<ToolsSection />
							<AupSection />
							<MailSection />
						</div>
					</div>
				</div>
			</UnsavedChanges>
		</AdminSection>
	);
}

/**
 * When the platform settings last changed. It moves with every section but
 * Email and alerts, which a root job applies and reports on its own, and
 * also with the log level on the Logs tab.
 */
function LastChanged() {
	const updatedAt = usePlatformSettings().data?.updatedAt ?? null;
	return (
		// Reserved while loading, so the sections do not move when it arrives.
		<p
			className="pk-text-compact pk-muted m-0 min-h-[18px]"
			data-testid="settings-last-changed"
		>
			{updatedAt ? (
				<>
					Last changed <time dateTime={updatedAt}>{longTime(updatedAt)}</time>
				</>
			) : null}
		</p>
	);
}
