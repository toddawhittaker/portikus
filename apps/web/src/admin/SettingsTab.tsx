import {
	CpuIdleLiftMinutes,
	CpuIdleLiftPercent,
	DEFAULT_ACCEPTABLE_USE_TEXT,
	LogLevel,
	MAX_ACCEPTABLE_USE_LENGTH,
} from "@portikus/contracts";
import {
	Button,
	CONTROL_CLASS,
	FIELD_CLASS,
	LABEL_CLASS,
	TextField,
	useToast,
} from "@portikus/ui";
import { useState } from "react";
import type { z } from "zod";
import { ApiError } from "../api/request.js";
import { GUARD_FIELDS, type GuardKey, parseGuardValue } from "./GuardDialog.js";
import { graceText } from "./graceText.js";
import { usePlatformSettings, useUpdatePlatformSettings } from "./queries.js";

/**
 * Reads a seconds input, or null when it is not a whole number at or above 0.
 * The upper bound is the largest value the API's 32-bit integer column takes.
 */
const MAX_SECONDS = 2147483647;

export function parseSeconds(value: string): number | null {
	if (!/^\d+$/.test(value.trim())) return null;
	const seconds = Number(value.trim());
	return seconds > MAX_SECONDS ? null : seconds;
}

export function errorText(error: unknown): string {
	if (error instanceof ApiError) return error.message;
	return "Something went wrong. Please try again.";
}

/** A field error, announced when it appears (issue #363). */
export function announced(error: string | null) {
	return error ? <span role="alert">{error}</span> : null;
}

/**
 * The platform-wide settings: grace period, idle stop, resource guard,
 * acceptable use and log level (SPEC.md §6.4, ADR 0032).
 */
export function SettingsTab() {
	return (
		<>
			<GraceSection />
			<IdleStopSection />
			<ResourceGuardSection />
			<AcceptableUseSection />
			<LogLevelSection />
		</>
	);
}

/** The platform setting behind each guard field. */
const GUARD_SETTING: Record<Exclude<GuardKey, "idleStopMinutes">, GuardSettingKey> = {
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
	| "cpuIdleLiftPercent";

interface GuardSettingField {
	key: GuardSettingKey;
	label: string;
	schema: z.ZodType<number>;
	rangeText: string;
}

/**
 * The Resource guard section's fields: the per-workspace ones, then the
 * automatic lift, which has no per-workspace override (#596). A function,
 * because GuardDialog imports this module before GUARD_FIELDS exists.
 */
function guardSettingFields(): GuardSettingField[] {
	return [
		...GUARD_FIELDS.filter((field) => field.key !== "idleStopMinutes").map((field) => ({
			...field,
			key: GUARD_SETTING[field.key as Exclude<GuardKey, "idleStopMinutes">],
		})),
		{
			key: "cpuIdleLiftMinutes",
			label: "Quiet time to lift (minutes)",
			schema: CpuIdleLiftMinutes,
			rangeText: "Enter a whole number from 1 to 60.",
		},
		{
			key: "cpuIdleLiftPercent",
			label: "Quiet below (%)",
			schema: CpuIdleLiftPercent,
			rangeText: "Enter 0 to turn it off, or a whole number up to 100.",
		},
	];
}

/** Reads one Resource guard field, or null when the entry is not allowed. */
export function parseGuardSetting(key: GuardSettingKey, text: string): number | null {
	const field = guardSettingFields().find((item) => item.key === key);
	const trimmed = text.trim();
	if (!field || !/^\d+$/.test(trimmed)) return null;
	const parsed = field.schema.safeParse(Number(trimmed));
	return parsed.success ? parsed.data : null;
}

function IdleStopSection() {
	const settings = usePlatformSettings();
	const update = useUpdatePlatformSettings();
	const toast = useToast();
	const [draft, setDraft] = useState<string | null>(null);
	const [error, setError] = useState<string | null>(null);

	const current = settings.data?.idleStopMinutes;
	const value = draft ?? (current === undefined ? "" : String(current));

	function save() {
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
		<section className="pk-card mt-6 max-w-160 p-6" aria-labelledby="idle-title">
			<h2 className="pk-text-heading m-0" id="idle-title">
				Idle stop
			</h2>
			<p className="pk-text-body pk-muted mt-1">
				How long a running workspace may go without a key press, click, file save or
				preview visit before the student is asked "Still working?". It stops five
				minutes later unless they answer. 0 means never. Each workspace can override
				this.
			</p>
			<div className="pk-actions mt-4 items-end">
				<TextField
					id="idle-minutes"
					label="Minutes"
					className="w-48"
					inputMode="numeric"
					data-testid="idle-input"
					value={value}
					// A read failure is shown once, in the grace section above.
					error={announced(error)}
					disabled={settings.isLoading}
					onChange={(event) => setDraft(event.target.value)}
				/>
				<Button
					variant="primary"
					data-testid="idle-save"
					loading={update.isPending}
					onClick={save}
				>
					Save
				</Button>
			</div>
		</section>
	);
}

function ResourceGuardSection() {
	const settings = usePlatformSettings();
	const update = useUpdatePlatformSettings();
	const toast = useToast();
	const [drafts, setDrafts] = useState<Partial<Record<GuardSettingKey, string>>>({});
	const [errors, setErrors] = useState<Partial<Record<GuardSettingKey, string>>>({});
	const [serverError, setServerError] = useState<string | null>(null);
	const fields = guardSettingFields();
	const firstError = fields.find((field) => errors[field.key])?.key;

	function fieldValue(key: GuardSettingKey): string {
		const saved = settings.data?.[key];
		return drafts[key] ?? (saved === undefined ? "" : String(saved));
	}

	function save() {
		const body: Record<string, number> = {};
		const found: Partial<Record<GuardSettingKey, string>> = {};
		for (const field of fields) {
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
		<section className="pk-card mt-6 max-w-160 p-6" aria-labelledby="guard-title">
			<h2 className="pk-text-heading m-0" id="guard-title">
				Resource guard
			</h2>
			<p className="pk-text-body pk-muted mt-1">
				A workspace whose CPU average stays above the CPU threshold for the window is
				slowed to the throttled share of its CPU. It gets full speed back once its CPU
				average stays below the quiet percent for the quiet time, when it is stopped and
				started, or when an administrator lifts it. One above the memory threshold is
				flagged; nothing is slowed. A threshold of 100 turns that check off, and a quiet
				percent of 0 turns the automatic lift off. Each workspace can override all but
				the two quiet settings.
			</p>
			<div className="mt-4 grid grid-cols-2 gap-4">
				{fields.map((field) => {
					const key = field.key;
					const error = errors[key] ?? null;
					return (
						<TextField
							key={key}
							id={`settings-${key}`}
							label={field.label}
							inputMode="numeric"
							data-testid={`settings-${key}`}
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
			{serverError ? (
				<p className="m-0 mt-3 text-[13px] text-status-error" role="alert">
					{serverError}
				</p>
			) : null}
			<div className="pk-actions mt-4">
				<Button
					variant="primary"
					data-testid="guard-settings-save"
					loading={update.isPending}
					onClick={save}
				>
					Save
				</Button>
			</div>
		</section>
	);
}

/** Checks a statement before it is sent; null when it can be saved. */
export function acceptableUseError(text: string): string | null {
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
		<section className="pk-card mt-6 max-w-160 p-6" aria-labelledby="aup-title">
			<h2 className="pk-text-heading m-0" id="aup-title">
				Acceptable use
			</h2>
			<p className="pk-text-body pk-muted mt-1">
				The statement everyone accepts before using Portikus. Plain text; a blank line
				starts a new paragraph.
				{version === undefined ? null : ` This is version ${version}.`}
			</p>
			<div className={`${FIELD_CLASS} mt-4`}>
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
			<div className="pk-actions mt-4 items-center">
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
		</section>
	);
}

function GraceSection() {
	const settings = usePlatformSettings();
	const update = useUpdatePlatformSettings();
	const toast = useToast();
	const [draft, setDraft] = useState<string | null>(null);
	const [error, setError] = useState<string | null>(null);

	const current = settings.data?.shutdownGraceSeconds;
	const value = draft ?? (current === undefined ? "" : String(current));
	const seconds = parseSeconds(value);

	function save() {
		if (seconds === null) {
			setError("Enter a whole number of seconds, 0 or more.");
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
		<section className="pk-card mt-6 max-w-160 p-6" aria-labelledby="grace-title">
			<h2 className="pk-text-heading m-0" id="grace-title">
				Disconnect grace period
			</h2>
			<p className="pk-text-body pk-muted mt-1">
				How long a workspace keeps running after the last browser disconnects.
			</p>
			<div className="pk-actions mt-4 items-end">
				<TextField
					id="grace-seconds"
					label="Seconds"
					className="w-48"
					inputMode="numeric"
					data-testid="grace-input"
					value={value}
					hint={seconds === null ? undefined : graceText(seconds)}
					error={announced(
						error ?? (settings.isError ? errorText(settings.error) : null),
					)}
					disabled={settings.isLoading}
					onChange={(event) => setDraft(event.target.value)}
				/>
				<Button
					variant="primary"
					data-testid="grace-save"
					loading={update.isPending}
					onClick={save}
				>
					Save
				</Button>
			</div>
		</section>
	);
}

/** The value the select uses for "no override"; the API takes null. */
const SERVICE_DEFAULT = "default";

/**
 * The runtime log level every service follows (ADR 0012). "Use service
 * default" clears the override, so each service falls back to its own
 * LOG_LEVEL from the environment.
 */
function LogLevelSection() {
	const settings = usePlatformSettings();
	const update = useUpdatePlatformSettings();
	const toast = useToast();
	const [draft, setDraft] = useState<string | null>(null);
	const [error, setError] = useState<string | null>(null);

	const saved = settings.data?.logLevel ?? null;
	const value = draft ?? (saved === null ? SERVICE_DEFAULT : saved);

	function save() {
		setError(null);
		const parsed = LogLevel.safeParse(value);
		update.mutate(
			{ logLevel: parsed.success ? parsed.data : null },
			{
				onSuccess: () => {
					setDraft(null);
					toast.show({ tone: "success", title: "Log level saved" });
				},
				onError: (failure) => setError(errorText(failure)),
			},
		);
	}

	return (
		<section className="pk-card mt-6 max-w-160 p-6" aria-labelledby="log-level-title">
			<h2 className="pk-text-heading m-0" id="log-level-title">
				Log level
			</h2>
			<p className="pk-text-body pk-muted mt-1">
				How much every service logs. Takes effect within a few seconds.
			</p>
			<div className="pk-actions mt-4 items-end">
				<div className={FIELD_CLASS}>
					<label className={LABEL_CLASS} htmlFor="log-level">
						Level
					</label>
					<select
						id="log-level"
						className={`${CONTROL_CLASS} w-48 cursor-pointer disabled:border-line disabled:bg-surface-sunken disabled:text-ink-faint`}
						data-testid="log-level-select"
						value={value}
						disabled={settings.isLoading}
						aria-invalid={error ? true : undefined}
						aria-describedby={error ? "log-level-err" : undefined}
						onChange={(event) => setDraft(event.target.value)}
					>
						<option value={SERVICE_DEFAULT}>Use service default</option>
						{LogLevel.options.map((level) => (
							<option key={level} value={level}>
								{level}
							</option>
						))}
					</select>
					{error ? (
						<p
							className="pk-error m-0 text-[12px] leading-4 text-status-error"
							id="log-level-err"
							role="alert"
						>
							{error}
						</p>
					) : null}
				</div>
				<Button
					variant="primary"
					data-testid="log-level-save"
					loading={update.isPending}
					onClick={save}
				>
					Save
				</Button>
			</div>
		</section>
	);
}
