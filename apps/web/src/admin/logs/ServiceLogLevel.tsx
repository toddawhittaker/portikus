import { LogLevel as LogLevelSchema } from "@portikus/contracts";
import { Button, CONTROL_CLASS, LABEL_CLASS, Toggletip, useToast } from "@portikus/ui";
import { type FormEvent, useState } from "react";
import { errorText } from "../../api/request.js";
import { usePlatformSettings, useUpdatePlatformSettings } from "../queries.js";
import { LEVEL_LABELS } from "./line.js";

/** The value the select uses for "no override"; the API takes null. */
const SERVICE_DEFAULT = "default";

/**
 * The runtime log level every service follows (ADR 0012). "Use service
 * default" clears the override, so each service falls back to its own
 * LOG_LEVEL from the environment. It sits here, beside the lines it
 * decides, rather than on the Settings tab.
 */
export function ServiceLogLevel() {
	const settings = usePlatformSettings();
	const update = useUpdatePlatformSettings();
	const toast = useToast();
	const [draft, setDraft] = useState<string | null>(null);
	const [error, setError] = useState<string | null>(null);

	const saved = settings.data?.logLevel ?? null;
	const value = draft ?? (saved === null ? SERVICE_DEFAULT : saved);

	function save(event: FormEvent) {
		event.preventDefault();
		setError(null);
		const parsed = LogLevelSchema.safeParse(value);
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
		<form
			className="flex flex-col gap-1.5"
			onSubmit={save}
			data-testid="log-level-form"
		>
			<div className="flex flex-wrap items-center gap-2">
				<span className="flex items-center gap-1">
					<label className={LABEL_CLASS} htmlFor="log-level">
						Services log at
					</label>
					<Toggletip label="Service log level">
						How much every service writes. Service default uses each service's own
						setting. Debug fills the journal quickly, so turn it back down when you are
						done.
					</Toggletip>
				</span>
				<div className="w-48">
					<select
						id="log-level"
						className={`${CONTROL_CLASS} cursor-pointer disabled:border-line disabled:bg-surface-sunken disabled:text-ink-faint`}
						data-testid="log-level-select"
						value={value}
						disabled={settings.isLoading}
						aria-invalid={error ? true : undefined}
						aria-describedby={error ? "log-level-err" : undefined}
						onChange={(event) => setDraft(event.target.value)}
					>
						<option value={SERVICE_DEFAULT}>Service default</option>
						{LogLevelSchema.options.map((level) => (
							<option key={level} value={level}>
								{LEVEL_LABELS[level]}
							</option>
						))}
					</select>
				</div>
				<Button type="submit" data-testid="log-level-save" loading={update.isPending}>
					Save
				</Button>
			</div>
			{error ? (
				<p
					className="pk-error m-0 text-[12px] leading-4 text-status-error"
					id="log-level-err"
					role="alert"
				>
					{error}
				</p>
			) : null}
		</form>
	);
}
