import type { UpdatePlatformSettingsRequest } from "@portikus/contracts";
import type { FormEvent, ReactNode } from "react";
import { usePlatformSettings } from "../queries.js";
import { useDraft } from "./draft.js";
import {
	NUMBER_SETTINGS,
	type NumberKey,
	numberBody,
	savedTexts,
	withUnit,
} from "./numberSettings.js";
import { footerState, SaveFooter } from "./SaveFooter.js";
import { LoadFailed, SectionCard, SectionGroup } from "./SectionCard.js";
import { SettingRow, SettingRowSkeleton, SettingRows } from "./SettingRow.js";
import { useFocusFirstError, useSaveSettings } from "./save.js";
import { SECTIONS, type SettingsSection } from "./sections.js";
import { useReportUnsaved } from "./unsaved.js";

/** Each number field's id, which is also its test id. */
export const fieldId = (key: string) => `settings-${key}`;

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
		id: "guard-lift",
		title: "Give full speed back",
		keys: ["cpuIdleLiftMinutes", "cpuIdleLiftPercent"],
	},
	{
		id: "guard-hold",
		title: "Keep repeat cases slowed",
		keys: ["cpuThrottleHoldAfter", "cpuThrottleHoldHours"],
	},
	{
		id: "guard-memory",
		title: "Flag high memory",
		keys: ["memoryGuardThresholdPercent"],
	},
] as const satisfies readonly {
	id: string;
	title: string;
	keys: readonly NumberKey[];
}[];

const GUARD_KEYS = [
	"guardWindowMinutes",
	...GUARD_GROUPS.flatMap((group) => group.keys),
] as const satisfies readonly NumberKey[];

/**
 * A section of number settings: the form, its rows and its footer. `layout`
 * places the rows, so the guard can put them in groups.
 */
function NumberSection<K extends NumberKey>({
	section,
	description,
	keys,
	saveLabel,
	announceLoadFailure,
	layout,
}: {
	section: SettingsSection;
	description: string;
	keys: readonly K[];
	saveLabel: string;
	announceLoadFailure: boolean;
	layout: (row: (key: K) => ReactNode) => ReactNode;
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
			<SectionCard section={section} description={description}>
				{settings.isError ? (
					<LoadFailed
						error={settings.error}
						retrying={settings.isFetching}
						announce={announceLoadFailure}
						onRetry={() => void settings.refetch()}
					/>
				) : (
					// The same layout with each row's shape, so nothing moves when the values arrive.
					<div aria-busy="true" className="grid gap-5">
						{layout((key) => (
							<SettingRowSkeleton key={key} />
						))}
					</div>
				)}
			</SectionCard>
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
		<SectionCard section={section} description={description}>
			<form className="grid min-w-0 gap-5" noValidate onSubmit={submit}>
				{layout(row)}
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
			description="Slows a workspace that keeps its CPUs busy for a long time, and flags one that stays near its memory limit. Use is averaged, so a short burst such as a build barely counts."
			keys={GUARD_KEYS}
			saveLabel="Save resource guard"
			announceLoadFailure={false}
			layout={(row) => (
				<>
					<SettingRows>{row("guardWindowMinutes")}</SettingRows>
					{GUARD_GROUPS.map((group) => (
						<SectionGroup key={group.id} id={group.id} title={group.title}>
							<SettingRows>{group.keys.map(row)}</SettingRows>
						</SectionGroup>
					))}
				</>
			)}
		/>
	);
}
