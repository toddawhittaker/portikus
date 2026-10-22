import {
	CODE_HELP_LANGUAGE_IDS,
	type CodeHelpLanguage,
	type PlatformSettings,
	type UpdatePlatformSettingsRequest,
} from "@portikus/contracts";
import { Checkbox, HINT_CLASS, LABEL_CLASS, Skeleton } from "@portikus/ui";
import type { FormEvent } from "react";
import { useSiteLimits } from "../health/queries.js";
import { usePlatformSettings } from "../queries.js";
import { COMING_LATER_LANGUAGES, SHIPPED_LANGUAGES } from "./codeHelpLanguages.js";
import { useDraft } from "./draft.js";
import { estimate, LANGUAGE_MIB } from "./estimate.js";
import { footerState, SaveFooter } from "./SaveFooter.js";
import { LoadFailed, SectionCard, SectionGroup } from "./SectionCard.js";
import { NotSaved } from "./SettingRow.js";
import { useSaveSettings } from "./save.js";
import { SECTIONS } from "./sections.js";
import { useReportUnsaved } from "./unsaved.js";

const SECTION = SECTIONS.tools;
const DESCRIPTION =
	"What the editor and terminals offer every student. A student sees a change when they next load the page or return to the window.";

/** One checkbox per shipped language, then voice input. */
export type ToolValues = Record<CodeHelpLanguage, boolean> & {
	voiceInputEnabled: boolean;
};

export function toolValues(settings: PlatformSettings): ToolValues {
	const values = { voiceInputEnabled: settings.voiceInputEnabled } as ToolValues;
	for (const id of CODE_HELP_LANGUAGE_IDS) {
		values[id] = settings.codeHelpLanguages.includes(id);
	}
	return values;
}

/**
 * The body for the changed fields. The languages go as one set, and only
 * when one of them changed, so saving voice input alone leaves code help
 * as it is.
 */
export function toolsBody(
	changed: readonly (keyof ToolValues)[],
	value: (key: keyof ToolValues) => boolean,
): UpdatePlatformSettingsRequest {
	const body: UpdatePlatformSettingsRequest = {};
	if (CODE_HELP_LANGUAGE_IDS.some((id) => changed.includes(id))) {
		body.codeHelpLanguages = CODE_HELP_LANGUAGE_IDS.filter((id) => value(id));
	}
	if (changed.includes("voiceInputEnabled")) {
		body.voiceInputEnabled = value("voiceInputEnabled");
	}
	return body;
}

const count = new Intl.NumberFormat("en");
const onOff = (on: boolean) => (on ? "on" : "off");

export function ToolsSection() {
	const settings = usePlatformSettings();
	const saved = settings.data ? toolValues(settings.data) : undefined;
	const draft = useDraft(saved);
	const save = useSaveSettings();
	useReportUnsaved(SECTION.title, draft.changed.length);

	function submit(event: FormEvent) {
		event.preventDefault();
		if (draft.changed.length === 0 || save.pending) return;
		save.send(
			toolsBody(draft.changed, (key) => draft.value(key) === true),
			draft,
		);
	}

	if (!saved) {
		return (
			<SectionCard section={SECTION} description={DESCRIPTION}>
				{settings.isError ? (
					<LoadFailed
						error={settings.error}
						retrying={settings.isFetching}
						announce={false}
						onRetry={() => void settings.refetch()}
					/>
				) : (
					<div aria-busy="true" className="grid max-w-[42rem] gap-5">
						<Skeleton variant="block" height="22rem" />
						<Skeleton variant="block" height="11rem" />
						<Skeleton variant="block" height="4rem" />
					</div>
				)}
			</SectionCard>
		);
	}

	const ticked = CODE_HELP_LANGUAGE_IDS.filter((id) => draft.value(id) === true);
	return (
		<SectionCard section={SECTION} description={DESCRIPTION}>
			<form className="grid min-w-0 gap-5" noValidate onSubmit={submit}>
				<SectionGroup
					id="code-help-title"
					title="Code help"
					description="Completion, hover, go to definition, rename, format and error checking in the editor. Most languages run a language server in each student's workspace while a file of that language is open, so each one costs memory."
				>
					<fieldset
						className="m-0 grid min-w-0 gap-2 border-0 p-0"
						aria-describedby="code-help-plain"
					>
						<legend className={`${LABEL_CLASS} mb-1 p-0`}>
							Languages with code help
						</legend>
						<p className={HINT_CLASS} id="code-help-plain">
							A language left unticked still opens in the editor with syntax colouring,
							but no completion, error checking or Problems tab.
						</p>
						<ul
							className="m-0 grid max-w-[42rem] list-none divide-y divide-line border-y border-line p-0"
							data-testid="code-help-languages"
						>
							{CODE_HELP_LANGUAGE_IDS.map((id) => (
								<LanguageRow
									key={id}
									name={SHIPPED_LANGUAGES[id].name}
									runs={SHIPPED_LANGUAGES[id].runs}
									figure={`${count.format(LANGUAGE_MIB[id])} MiB per student`}
									checked={draft.value(id) === true}
									was={draft.isChanged(id) ? onOff(saved[id]) : null}
									onChange={(on) => draft.edit(id, on)}
								/>
							))}
							{COMING_LATER_LANGUAGES.map((language) => (
								<LanguageRow
									key={language.name}
									name={language.name}
									runs={language.runs}
									figure={null}
									checked={false}
									was={null}
								/>
							))}
						</ul>
					</fieldset>
					<CodeHelpEstimate ticked={ticked} />
				</SectionGroup>
				<SectionGroup id="voice-input-title" title="Voice input">
					<Checkbox
						label="Allow voice input"
						description={
							<>
								Students can dictate into terminals and files with the browser's own
								speech recognition. The audio goes to the browser vendor, never to
								Portikus. When off, no microphone is shown.
								{draft.isChanged("voiceInputEnabled") ? (
									<NotSaved was={onOff(saved.voiceInputEnabled)} />
								) : null}
							</>
						}
						checked={draft.value("voiceInputEnabled") === true}
						onChange={(event) => draft.edit("voiceInputEnabled", event.target.checked)}
					/>
				</SectionGroup>
				<SaveFooter
					id={SECTION.id}
					count={draft.changed.length}
					state={footerState({
						count: draft.changed.length,
						firstError: null,
						failure: draft.failure,
						justSaved: draft.justSaved,
					})}
					saveLabel="Save student tools"
					pending={save.pending}
					onDiscard={draft.discard}
				/>
			</form>
		</SectionCard>
	);
}

/**
 * One language: its box and servers on the left, its memory on the right.
 * A language with no `figure` is coming later: it stays in the tab order
 * and says why it cannot be ticked (SPEC.md section 25.8).
 */
function LanguageRow({
	name,
	runs,
	figure,
	checked,
	was,
	onChange,
}: {
	name: string;
	runs: string;
	figure: string | null;
	checked: boolean;
	was: string | null;
	onChange?: (on: boolean) => void;
}) {
	const later = figure === null;
	return (
		<li className="grid grid-cols-[minmax(0,1fr)] items-start gap-x-4 gap-y-1 py-2 @min-[30rem]/card:grid-cols-[minmax(0,1fr)_auto]">
			<Checkbox
				className={later ? "cursor-not-allowed text-ink-muted" : undefined}
				label={name}
				description={
					<>
						{runs}
						{/* The figure on the right is drawn for sighted readers; this is what a screen reader hears. */}
						<span className="sr-only">
							{later
								? ". Coming later: its language server is not installed yet, so it cannot be ticked."
								: `. About ${figure}.`}
						</span>
						{was === null ? null : <NotSaved was={was} />}
					</>
				}
				checked={checked}
				ariaDisabled={later}
				onChange={(event) => {
					if (!later) onChange?.(event.target.checked);
				}}
			/>
			<span
				aria-hidden={true}
				className={`ps-6 text-[length:var(--pk-font)] tabular-nums @min-[30rem]/card:ps-0 @min-[30rem]/card:text-end ${later ? "text-ink-muted" : "text-ink"}`}
			>
				{figure ?? "Coming later"}
			</span>
		</li>
	);
}

const gib = new Intl.NumberFormat("en", { maximumFractionDigits: 1 });

/**
 * What the ticked languages cost per student and how many students this
 * server's memory holds, by course profile. Only the headline is announced
 * as the boxes change, not the whole table.
 */
function CodeHelpEstimate({ ticked }: { ticked: readonly CodeHelpLanguage[] }) {
	const health = useSiteLimits();
	const totalBytes = health.data?.host?.memory.totalBytes ?? null;
	const result = estimate(totalBytes, ticked);
	const students = (n: number | null) =>
		n === null ? "Server memory not known yet" : `about ${count.format(n)}`;
	const memory =
		totalBytes === null
			? "Server memory is not known yet, so the number of students is not shown. The platform itself uses about 1.4 GiB, and 2 GiB is kept free."
			: `This server has ${gib.format(totalBytes / 1024 ** 3)} GiB, the platform itself uses about 1.4 GiB, and 2 GiB is kept free.`;
	return (
		<div className="grid min-w-0 max-w-[42rem] gap-2" data-testid="code-help-estimate">
			<output
				className="pk-text-body block font-semibold"
				data-testid="code-help-headline"
			>
				{ticked.length === 0
					? "Code help is off. The editor shows syntax colouring only."
					: `Code help adds about ${count.format(result.addedMiB)} MiB per student.`}
			</output>
			<div className="pk-table-wrap">
				<table className="pk-table [&_th]:whitespace-normal">
					<caption className="sr-only">
						Memory per student, and students this server holds, with the languages
						ticked
					</caption>
					<thead>
						<tr>
							<th scope="col">Course profile</th>
							<th scope="col" className="pk-num">
								Memory per student
							</th>
							<th scope="col" className="pk-num">
								Students on this server
							</th>
						</tr>
					</thead>
					<tbody>
						{(
							[
								["traditional", "Traditional, no coding agent"],
								["agentic", "Agentic, with a coding agent"],
							] as const
						).map(([profile, label]) => (
							<tr key={profile}>
								<th scope="row">{label}</th>
								<td className="pk-num">
									{count.format(result[profile].perStudentMiB)} MiB
								</td>
								<td className="pk-num whitespace-normal">
									{students(result[profile].students)}
								</td>
							</tr>
						))}
					</tbody>
				</table>
			</div>
			<p className={`${HINT_CLASS} max-w-[72ch]`}>
				Worst case, with every ticked language open at once. Memory only. {memory}{" "}
				Workspace figures are from the 25-student load test; a real coding agent can use
				more than the test's.
			</p>
		</div>
	);
}
