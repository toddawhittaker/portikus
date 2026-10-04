import {
	CpuIdleLiftMinutes,
	CpuIdleLiftPercent,
	CpuThrottleHoldAfter,
	CpuThrottleHoldHours,
	DEFAULT_ACCEPTABLE_USE_TEXT,
	MAX_ACCEPTABLE_USE_LENGTH,
} from "@portikus/contracts";
import {
	Button,
	CONTROL_CLASS,
	FIELD_CLASS,
	LABEL_CLASS,
	TextField,
	Toggletip,
	useToast,
} from "@portikus/ui";
import { type FormEvent, useState } from "react";
import type { z } from "zod";
import { errorText } from "../api/request.js";
import { announced } from "../common/announced.js";
import { AdminGroup, AdminSection } from "./AdminSection.js";
import { graceMinutes, graceText, parseGraceMinutes } from "./graceText.js";
import { GUARD_FIELDS, type GuardKey, parseGuardValue } from "./guardFields.js";
import { usePlatformSettings, useUpdatePlatformSettings } from "./queries.js";

/**
 * The platform-wide settings: when workspaces stop, the resource guard and
 * the acceptable-use statement (SPEC.md §6.4, §19.4, ADR 0032). One column
 * of cards, as on the other tabs; the log level lives on the Logs tab.
 */
export function SettingsTab() {
	return (
		<AdminSection
			title="Settings"
			intro={{
				id: "admin-settings",
				helpAnchor: "admin-settings",
				text: "Site-wide rules for when workspaces stop, how heavy use is slowed, and the statement everyone accepts. Most can be changed for one workspace from its panel on the Users tab.",
			}}
		>
			<div className="flex max-w-[72ch] flex-col gap-4" data-testid="settings-sections">
				<StopSection />
				<ResourceGuardSection />
				<AcceptableUseSection />
			</div>
		</AdminSection>
	);
}

function StopSection() {
	return (
		<AdminGroup
			id="stop-title"
			title="When workspaces stop"
			description="A running workspace stops when the disconnect grace or idle stop runs out, whichever comes first, unless its owner chose Keep running."
		>
			<div className="grid grid-cols-[repeat(auto-fit,minmax(14rem,1fr))] items-start gap-6">
				<GraceField />
				<IdleStopField />
				<KeepRunningField />
			</div>
		</AdminGroup>
	);
}

/** The platform setting behind each guard field. */
/** The per-workspace fields that sit in "When workspaces stop", not the guard. */
type StopKey = "idleStopMinutes" | "keepRunningMaxHours";

const GUARD_SETTING: Record<Exclude<GuardKey, StopKey>, GuardSettingKey> = {
	cpuThresholdPercent: "cpuGuardThresholdPercent",
	memoryThresholdPercent: "memoryGuardThresholdPercent",
	windowMinutes: "guardWindowMinutes",
	throttleSharePercent: "cpuThrottleSharePercent",
};

type GuardSettingKey =
	| "cpuGuardThresholdPercent"
	| "memoryGuardThresholdPercent"
	| "guardWindowMinutes"
	| "cpuThrottleSharePercent"
	| "cpuIdleLiftMinutes"
	| "cpuIdleLiftPercent"
	| "cpuThrottleHoldAfter"
	| "cpuThrottleHoldHours";

interface GuardSettingField {
	key: GuardSettingKey;
	/** The field's id and test id, named as in the per-workspace dialog. */
	name: string;
	label: string;
	schema: z.ZodType<number>;
	rangeText: string;
}

/**
 * The Resource guard section's fields: the per-workspace ones, then the
 * automatic lift and the throttle hold (SPEC.md §19.4), which have no
 * per-workspace override.
 */
const GUARD_SETTING_FIELDS: GuardSettingField[] = [
	...GUARD_FIELDS.filter(
		(field) => field.key !== "idleStopMinutes" && field.key !== "keepRunningMaxHours",
	).map((field) => ({
		...field,
		name: field.key,
		key: GUARD_SETTING[field.key as Exclude<GuardKey, StopKey>],
	})),
	{
		key: "cpuIdleLiftMinutes",
		name: "cpuIdleLiftMinutes",
		label: "Quiet time to lift (minutes)",
		schema: CpuIdleLiftMinutes,
		rangeText: "Enter a whole number from 1 to 60.",
	},
	{
		key: "cpuIdleLiftPercent",
		name: "cpuIdleLiftPercent",
		label: "Quiet below (%)",
		schema: CpuIdleLiftPercent,
		rangeText: "Enter 0 to turn it off, or a whole number up to 100.",
	},
	{
		key: "cpuThrottleHoldAfter",
		name: "cpuThrottleHoldAfter",
		label: "Hold after throttles",
		schema: CpuThrottleHoldAfter,
		rangeText: "Enter 0 to turn it off, or a whole number up to 10.",
	},
	{
		key: "cpuThrottleHoldHours",
		name: "cpuThrottleHoldHours",
		label: "Hold window (hours)",
		schema: CpuThrottleHoldHours,
		rangeText: "Enter a whole number from 1 to 168.",
	},
];

/** What each guard field means, checked against SPEC.md §19.4. */
const GUARD_HELP: Record<GuardSettingKey, string> = {
	cpuGuardThresholdPercent:
		"The CPU use, as a share of the workspace's CPUs, that counts as heavy. 100 turns CPU slowing off.",
	guardWindowMinutes:
		"The period CPU and memory use are averaged over before a workspace is slowed or flagged. A short burst, such as a build, barely moves the average.",
	cpuThrottleSharePercent:
		"How much of its CPU a slowed workspace gets. 25 means a quarter. 100 means slowing changes nothing.",
	cpuIdleLiftMinutes:
		"How long a slowed workspace must stay quiet before it gets full speed back by itself. Stopping and starting it also gives full speed back, unless it is held.",
	cpuIdleLiftPercent:
		"Use under this share, and under half the throttled share, counts as quiet. 0 turns the automatic lift off.",
	cpuThrottleHoldAfter:
		"After this many slowdowns within the hold window, the workspace stays slowed even through a restart. It still gets full speed back when it goes quiet or you lift it. 0 turns this off.",
	cpuThrottleHoldHours: "The period, in hours, the hold counts slowdowns over.",
	memoryGuardThresholdPercent:
		"Memory use, as a share of the workspace's limit, that flags it on the Health and Users tabs. Nothing is slowed. 100 turns this off.",
};

/** Reads one Resource guard field, or null when the entry is not allowed. */
function parseGuardSetting(key: GuardSettingKey, text: string): number | null {
	const field = GUARD_SETTING_FIELDS.find((item) => item.key === key);
	const trimmed = text.trim();
	if (!field || !/^\d+$/.test(trimmed)) return null;
	const parsed = field.schema.safeParse(Number(trimmed));
	return parsed.success ? parsed.data : null;
}

function IdleStopField() {
	const settings = usePlatformSettings();
	const update = useUpdatePlatformSettings();
	const toast = useToast();
	const [draft, setDraft] = useState<string | null>(null);
	const [error, setError] = useState<string | null>(null);

	const current = settings.data?.idleStopMinutes;
	const value = draft ?? (current === undefined ? "" : String(current));

	function save(event: FormEvent) {
		event.preventDefault();
		const minutes = parseGuardValue("idleStopMinutes", value);
		if (minutes === null) {
			setError("Enter 0 for never, or a whole number from 10 to 1440.");
			return;
		}
		setError(null);
		update.mutate(
			{ idleStopMinutes: minutes },
			{
				onSuccess: () => {
					setDraft(null);
					toast.show({ tone: "success", title: "Idle stop saved" });
				},
				onError: (failure) => setError(errorText(failure)),
			},
		);
	}

	return (
		<form className="flex flex-col gap-3" onSubmit={save} noValidate>
			<TextField
				className="w-56"
				id="idle-minutes"
				label="Idle stop (minutes)"
				help={
					<Toggletip label="Idle stop">
						With no key press, click, file save or preview visit for this long, the
						student is asked "Still working?", and the workspace stops five minutes
						later. This counts even while a browser is open.
					</Toggletip>
				}
				inputMode="numeric"
				data-testid="idle-input"
				value={value}
				hint="0 means never."
				// A read failure is shown once, in the grace field beside this one.
				error={announced(error)}
				disabled={settings.isLoading}
				onChange={(event) => setDraft(event.target.value)}
			/>
			<div className="pk-actions">
				<Button
					variant="primary"
					type="submit"
					data-testid="idle-save"
					loading={update.isPending}
				>
					Save
				</Button>
			</div>
		</form>
	);
}

/** The cap on a student's "Keep running until" hold. */
function KeepRunningField() {
	const settings = usePlatformSettings();
	const update = useUpdatePlatformSettings();
	const toast = useToast();
	const [draft, setDraft] = useState<string | null>(null);
	const [error, setError] = useState<string | null>(null);

	const current = settings.data?.keepRunningMaxHours;
	const value = draft ?? (current === undefined ? "" : String(current));

	function save(event: FormEvent) {
		event.preventDefault();
		const hours = parseGuardValue("keepRunningMaxHours", value);
		if (hours === null) {
			setError("Enter 0 to turn it off, or a whole number up to 168.");
			return;
		}
		setError(null);
		update.mutate(
			{ keepRunningMaxHours: hours },
			{
				onSuccess: () => {
					setDraft(null);
					toast.show({ tone: "success", title: "Keep running saved" });
				},
				onError: (failure) => setError(errorText(failure)),
			},
		);
	}

	return (
		<form className="flex flex-col gap-3" onSubmit={save} noValidate>
			<TextField
				className="w-56"
				id="keep-running-max-hours"
				label="Longest keep running (hours)"
				help={
					<Toggletip label="Keep running">
						A student can keep their workspace running for up to this many hours, for
						example while an agent works overnight. Neither the grace period nor idle
						stop applies until then. Lowering it shortens holds already set.
					</Toggletip>
				}
				inputMode="numeric"
				data-testid="keep-running-max-input"
				value={value}
				hint="0 turns it off."
				// A read failure is shown once, in the grace field.
				error={announced(error)}
				disabled={settings.isLoading}
				onChange={(event) => setDraft(event.target.value)}
			/>
			<div className="pk-actions">
				<Button
					variant="primary"
					type="submit"
					data-testid="keep-running-max-save"
					loading={update.isPending}
				>
					Save
				</Button>
			</div>
		</form>
	);
}

/** The four groups of guard fields, each with the one line that explains it. */
const GUARD_GROUPS: {
	id: string;
	legend: string;
	line: string;
	keys: GuardSettingKey[];
}[] = [
	{
		id: "guard-cpu",
		legend: "Slow down heavy CPU use",
		line: "A workspace whose CPU use averages above the threshold for the whole window is slowed to the throttled share.",
		keys: ["cpuGuardThresholdPercent", "guardWindowMinutes", "cpuThrottleSharePercent"],
	},
	{
		id: "guard-lift",
		legend: "Give full speed back",
		line: "A slowed workspace gets full speed back by itself once it stays quiet for the quiet time.",
		keys: ["cpuIdleLiftMinutes", "cpuIdleLiftPercent"],
	},
	{
		id: "guard-hold",
		legend: "Keep repeat cases slowed",
		line: "A workspace slowed this many times within the hold window stays slowed through a restart.",
		keys: ["cpuThrottleHoldAfter", "cpuThrottleHoldHours"],
	},
	{
		id: "guard-memory",
		legend: "Flag high memory",
		line: "A workspace whose memory use averages above the threshold for the window is flagged. Nothing is slowed.",
		keys: ["memoryGuardThresholdPercent"],
	},
];

/** The guard fields in the order the groups show them, so the first error is the first seen. */
const GUARD_FIELDS_SHOWN: GuardSettingField[] = GUARD_GROUPS.flatMap((group) =>
	group.keys.map((key) => {
		const field = GUARD_SETTING_FIELDS.find((item) => item.key === key);
		if (!field) throw new Error(`no guard field ${key}`);
		return field;
	}),
);

function ResourceGuardSection() {
	const settings = usePlatformSettings();
	const update = useUpdatePlatformSettings();
	const toast = useToast();
	const [drafts, setDrafts] = useState<Partial<Record<GuardSettingKey, string>>>({});
	const [errors, setErrors] = useState<Partial<Record<GuardSettingKey, string>>>({});
	const [serverError, setServerError] = useState<string | null>(null);
	const firstError = GUARD_FIELDS_SHOWN.find((field) => errors[field.key])?.key;

	function fieldValue(key: GuardSettingKey): string {
		const saved = settings.data?.[key];
		return drafts[key] ?? (saved === undefined ? "" : String(saved));
	}

	function save(event: FormEvent) {
		event.preventDefault();
		const body: Record<string, number> = {};
		const found: Partial<Record<GuardSettingKey, string>> = {};
		for (const field of GUARD_FIELDS_SHOWN) {
			const value = parseGuardSetting(field.key, fieldValue(field.key));
			if (value === null) found[field.key] = field.rangeText;
			else body[field.key] = value;
		}
		setErrors(found);
		setServerError(null);
		if (Object.keys(found).length > 0) return;
		update.mutate(body, {
			onSuccess: () => {
				setDrafts({});
				toast.show({ tone: "success", title: "Resource guard saved" });
			},
			onError: (failure) => setServerError(errorText(failure)),
		});
	}

	return (
		<AdminGroup
			id="guard-title"
			title="Resource guard"
			description="Slows a workspace that keeps its CPUs busy for a long time, and flags one that stays near its memory limit."
		>
			<form className="flex flex-col gap-5" onSubmit={save} noValidate>
				{GUARD_GROUPS.map((group) => (
					<fieldset
						key={group.id}
						className="m-0 min-w-0 border-0 p-0"
						aria-describedby={`${group.id}-line`}
						data-testid={group.id}
					>
						<legend className="pk-text-body m-0 p-0 font-semibold">
							{group.legend}
						</legend>
						<div className="flex flex-col gap-3">
							<p className="pk-text-compact pk-muted m-0" id={`${group.id}-line`}>
								{group.line}
							</p>
							<div className="flex flex-wrap items-start gap-x-3 gap-y-3">
								{group.keys.map((key) => {
									const field = GUARD_FIELDS_SHOWN.find((item) => item.key === key);
									if (!field) return null;
									const error = errors[key] ?? null;
									return (
										<TextField
											key={key}
											id={`settings-${field.name}`}
											className="w-52"
											label={field.label}
											help={
												<Toggletip label={field.label}>{GUARD_HELP[key]}</Toggletip>
											}
											inputMode="numeric"
											data-testid={`settings-${field.name}`}
											value={fieldValue(key)}
											// Only the first problem is announced, so a reader hears one alert.
											error={key === firstError ? announced(error) : error}
											disabled={settings.isLoading}
											onChange={(event) =>
												setDrafts((now) => ({ ...now, [key]: event.target.value }))
											}
										/>
									);
								})}
							</div>
						</div>
					</fieldset>
				))}
				{serverError ? (
					<p className="m-0 text-[13px] text-status-error" role="alert">
						{serverError}
					</p>
				) : null}
				<div className="pk-actions">
					<Button
						variant="primary"
						type="submit"
						data-testid="guard-settings-save"
						loading={update.isPending}
					>
						Save
					</Button>
				</div>
			</form>
		</AdminGroup>
	);
}

/** Checks a statement before it is sent; null when it can be saved. */
function acceptableUseError(text: string): string | null {
	if (text.trim() === "") return "Enter the statement, or reset it to the default.";
	if (text.length > MAX_ACCEPTABLE_USE_LENGTH) {
		return `The statement can be at most ${MAX_ACCEPTABLE_USE_LENGTH.toLocaleString("en")} characters.`;
	}
	return null;
}

function AcceptableUseSection() {
	const settings = usePlatformSettings();
	const update = useUpdatePlatformSettings();
	const toast = useToast();
	const [draft, setDraft] = useState<string | null>(null);
	const [error, setError] = useState<string | null>(null);

	const saved = settings.data?.acceptableUseText ?? null;
	const value = draft ?? saved ?? DEFAULT_ACCEPTABLE_USE_TEXT;
	const version = settings.data?.acceptableUseVersion;

	function send(text: string | null, title: string) {
		setError(null);
		update.mutate(
			{ acceptableUseText: text },
			{
				onSuccess: () => {
					setDraft(null);
					toast.show({ tone: "success", title });
				},
				onError: (failure) => setError(errorText(failure)),
			},
		);
	}

	function save() {
		const found = acceptableUseError(value);
		if (found) {
			setError(found);
			return;
		}
		send(value, "Acceptable-use statement saved");
	}

	return (
		<AdminGroup
			id="aup-title"
			title="Acceptable use"
			description={
				<>
					The statement everyone accepts before using Portikus. Plain text; a blank line
					starts a new paragraph.
					{version === undefined ? null : ` This is version ${version}.`}
				</>
			}
		>
			<div className={FIELD_CLASS}>
				<label className={LABEL_CLASS} htmlFor="aup-text">
					Statement
				</label>
				<textarea
					id="aup-text"
					className={`${CONTROL_CLASS} h-auto min-h-48 py-2 disabled:border-line disabled:bg-surface-sunken disabled:text-ink-faint`}
					data-testid="aup-text"
					rows={10}
					value={value}
					disabled={settings.isLoading}
					aria-invalid={error ? true : undefined}
					aria-describedby={error ? "aup-hint aup-err" : "aup-hint"}
					onChange={(event) => setDraft(event.target.value)}
				/>
				<p className="pk-muted m-0 text-[12px] leading-4" id="aup-hint">
					{value.length.toLocaleString("en")} of{" "}
					{MAX_ACCEPTABLE_USE_LENGTH.toLocaleString("en")} characters
				</p>
				{error ? (
					<p
						className="pk-error m-0 text-[12px] leading-4 text-status-error"
						id="aup-err"
						role="alert"
					>
						{error}
					</p>
				) : null}
			</div>
			<div className="pk-actions items-center">
				<Button
					variant="primary"
					data-testid="aup-save"
					loading={update.isPending && update.variables?.acceptableUseText !== null}
					aria-describedby="aup-reaccept"
					onClick={save}
				>
					Save
				</Button>
				<Button
					data-testid="aup-reset"
					loading={update.isPending && update.variables?.acceptableUseText === null}
					aria-describedby="aup-reaccept"
					onClick={() => send(null, "Acceptable-use statement reset to the default")}
				>
					Reset to default
				</Button>
				<p className="pk-text-compact pk-muted m-0" id="aup-reaccept">
					Saving a changed statement asks everyone, you included, to accept it again at
					their next page load.
				</p>
			</div>
		</AdminGroup>
	);
}

function GraceField() {
	const settings = usePlatformSettings();
	const update = useUpdatePlatformSettings();
	const toast = useToast();
	const [draft, setDraft] = useState<string | null>(null);
	const [error, setError] = useState<string | null>(null);

	// Shown in minutes; the API keeps seconds (SPEC.md section 6.4).
	const current = settings.data?.shutdownGraceSeconds;
	const value = draft ?? (current === undefined ? "" : graceMinutes(current));
	const seconds = parseGraceMinutes(value);

	function save(event: FormEvent) {
		event.preventDefault();
		if (seconds === null) {
			setError("Enter a number of minutes, 0 or more.");
			return;
		}
		setError(null);
		update.mutate(
			{ shutdownGraceSeconds: seconds },
			{
				onSuccess: () => {
					setDraft(null);
					toast.show({ tone: "success", title: "Grace period saved" });
				},
				onError: (failure) => setError(errorText(failure)),
			},
		);
	}

	return (
		<form className="flex flex-col gap-3" onSubmit={save} noValidate>
			<TextField
				className="w-56"
				id="grace-minutes"
				label="Disconnect grace (minutes)"
				help={
					<Toggletip label="Disconnect grace">
						How long a workspace keeps running after its last browser tab closes or
						loses its connection. A student who reloads or briefly loses Wi-Fi comes
						back to a running workspace. 0 keeps it running until stopped by hand.
					</Toggletip>
				}
				inputMode="decimal"
				data-testid="grace-input"
				value={value}
				hint={seconds === null ? undefined : graceText(seconds)}
				error={announced(
					error ?? (settings.isError ? errorText(settings.error) : null),
				)}
				disabled={settings.isLoading}
				onChange={(event) => setDraft(event.target.value)}
			/>
			<div className="pk-actions">
				<Button
					variant="primary"
					type="submit"
					data-testid="grace-save"
					loading={update.isPending}
				>
					Save
				</Button>
			</div>
		</form>
	);
}
