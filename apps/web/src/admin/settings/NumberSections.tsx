import type { UpdatePlatformSettingsRequest } from "@portikus/contracts";
import { Icon } from "@portikus/ui";
import type { FormEvent, ReactNode } from "react";
import { usePlatformSettings } from "../queries.js";
import { useDraft } from "./draft.js";
import { GuardPreview } from "./GuardPreview.js";
import {
	NUMBER_SETTINGS,
	type NumberKey,
	numberBody,
	savedTexts,
	withUnit,
} from "./numberSettings.js";
import { PerWorkspaceNote } from "./PerWorkspaceNote.js";
import { footerState, SaveFooter } from "./SaveFooter.js";
import { SectionCard, SectionGroup, SectionNotLoaded } from "./SectionCard.js";
import { SettingRow, SettingRowSkeleton, SettingRows } from "./SettingRow.js";
import { useFocusFirstError, useSaveSettings } from "./save.js";
import { SECTIONS, type SettingsSection } from "./sections.js";
import { useReportUnsaved } from "./unsaved.js";

/** Each number field's id, which is also its test id. */
const fieldId = (key: string) => `settings-${key}`;

const STOP_KEYS = [
	"shutdownGraceSeconds",
	"idleStopMinutes",
	"keepRunningMaxHours",
] as const satisfies readonly NumberKey[];

/** The guard's groups; their names are fixed by SPEC.md section 19.4. */
const GUARD_GROUPS = [
	{
		id: "guard-cpu",
		title: "Slow down heavy CPU use",
		keys: ["cpuGuardThresholdPercent", "cpuThrottleSharePercent"],
	},
	{
		id: "guard-memory",
		title: "Flag high memory",
		keys: ["memoryGuardThresholdPercent"],
	},
] as const satisfies readonly GuardGroup[];

/** The rules most sites leave at their defaults, closed until asked for. */
const ADVANCED_GROUPS = [
	{
		id: "guard-lift",
		title: "Give full speed back",
		keys: ["cpuIdleLiftMinutes", "cpuIdleLiftPercent"],
	},
	{
		id: "guard-hold",
		title: "Keep repeat cases slowed",
		keys: ["cpuThrottleHoldAfter", "cpuThrottleHoldHours"],
	},
] as const satisfies readonly GuardGroup[];

interface GuardGroup {
	id: string;
	title: string;
	keys: readonly NumberKey[];
}

const GUARD_KEYS = [
	"guardWindowMinutes",
	...GUARD_GROUPS.flatMap((group) => group.keys),
	...ADVANCED_GROUPS.flatMap((group) => group.keys),
] as const satisfies readonly NumberKey[];

/**
 * A section of number settings: the form, its rows and its footer. `layout`
 * places the rows, so the guard can put them in groups.
 */
function NumberSection<K extends NumberKey>({
	section,
	description,
	more,
	keys,
	saveLabel,
	announceLoadFailure,
	layout,
}: {
	section: SettingsSection;
	description: ReactNode;
	more?: ReactNode;
	keys: readonly K[];
	saveLabel: string;
	announceLoadFailure: boolean;
	layout: (
		row: (key: K) => ReactNode,
		/** The box's current text, saved or not, for a preview that follows the edits. */
		value: (key: K) => string | undefined,
	) => ReactNode;
}) {
	const settings = usePlatformSettings();
	const saved = savedTexts(keys, settings.data as Record<K, number> | undefined);
	const draft = useDraft(saved);
	const save = useSaveSettings();
	const focusFirstError = useFocusFirstError(draft.errors, fieldId);
	useReportUnsaved(section.title, draft.changed.length);

	function submit(event: FormEvent) {
		event.preventDefault();
		if (draft.changed.length === 0 || save.pending) return;
		const result = numberBody(draft.changed, (key) => draft.value(key) ?? "");
		if ("errors" in result) {
			draft.refuse(result.errors);
			focusFirstError();
			return;
		}
		save.send(result.body as UpdatePlatformSettingsRequest, draft);
	}

	if (!saved) {
		return (
			<SectionNotLoaded
				section={section}
				description={description}
				read={settings}
				announce={announceLoadFailure}
				// The same layout with each row's shape, so nothing moves when the values arrive.
				skeleton={layout(
					(key) => <SettingRowSkeleton key={key} />,
					() => undefined,
				)}
			/>
		);
	}

	const row = (key: K) => {
		const setting = NUMBER_SETTINGS[key];
		return (
			<SettingRow
				key={key}
				id={fieldId(key)}
				label={setting.label}
				description={setting.description}
				more={setting.more}
				unit={setting.unit}
				meta={setting.meta}
				inputMode={setting.inputMode}
				value={draft.value(key) ?? ""}
				was={draft.isChanged(key) ? withUnit(saved[key], setting.unit) : null}
				error={draft.errors[key]}
				onChange={(value) => draft.edit(key, value)}
			/>
		);
	};
	const firstError = keys.find((key) => draft.errors[key]);
	return (
		<SectionCard section={section} description={description} more={more}>
			<form className="grid min-w-0 gap-5" noValidate onSubmit={submit}>
				{layout(row, (key) => draft.value(key))}
				<SaveFooter
					id={section.id}
					count={draft.changed.length}
					state={footerState({
						count: draft.changed.length,
						firstError: firstError ? NUMBER_SETTINGS[firstError].label : null,
						failure: draft.failure,
						justSaved: draft.justSaved,
					})}
					saveLabel={saveLabel}
					pending={save.pending}
					onDiscard={draft.discard}
				/>
			</form>
		</SectionCard>
	);
}

export function StopSection() {
	return (
		<NumberSection
			section={SECTIONS.stop}
			description="A running workspace stops at whichever of these comes first, unless its owner chose Keep running."
			more={<PerWorkspaceNote />}
			keys={STOP_KEYS}
			saveLabel="Save stop times"
			// The first section speaks for all four that share one read.
			announceLoadFailure
			layout={(row) => <SettingRows>{STOP_KEYS.map(row)}</SettingRows>}
		/>
	);
}

export function GuardSection() {
	return (
		<NumberSection
			section={SECTIONS.guard}
			description="Slows a workspace that keeps its CPUs busy for a long time, and flags one that stays near its memory limit."
			more={
				<>
					Use is averaged, so a short burst such as a build barely counts.{" "}
					<PerWorkspaceNote />
				</>
			}
			keys={GUARD_KEYS}
			saveLabel="Save resource guard"
			announceLoadFailure={false}
			layout={(row, value) => (
				<>
					<GuardPreview value={value} />
					<SettingRows>{row("guardWindowMinutes")}</SettingRows>
					{GUARD_GROUPS.map((group) => (
						<SectionGroup key={group.id} id={group.id} title={group.title}>
							<SettingRows>{group.keys.map(row)}</SettingRows>
						</SectionGroup>
					))}
					<AdvancedRules>
						{ADVANCED_GROUPS.map((group) => (
							<SectionGroup key={group.id} id={group.id} title={group.title}>
								<SettingRows>{group.keys.map(row)}</SettingRows>
							</SectionGroup>
						))}
					</AdvancedRules>
				</>
			)}
		/>
	);
}

/**
 * When a slowed workspace gets full speed back and when it is held: closed
 * at first. A refused box inside opens it when focus moves to the box
 * (useFocusFirstError), so the box the save footer names is never hidden.
 */
function AdvancedRules({ children }: { children: ReactNode }) {
	return (
		<details className="group grid gap-3" data-testid="guard-advanced">
			<summary className="pk-focus-ring inline-flex min-h-8 w-fit cursor-pointer list-none items-center gap-1.5 rounded-xs text-[14px] font-semibold text-ink [&::-webkit-details-marker]:hidden @max-[30rem]/card:min-h-11">
				<Icon
					name="chevron-right"
					size="sm"
					className="flex-none group-open:rotate-90"
				/>
				Advanced rules
				<span className="sr-only">,</span>
				<span className="ms-1 font-normal text-ink-muted">
					Return to full speed, and holds
				</span>
			</summary>
			<div className="mt-3 grid gap-5">{children}</div>
		</details>
	);
}
