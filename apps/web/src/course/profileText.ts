import type { CourseProfile } from "@portikus/contracts";

/** What Traditional hides (SPEC.md §8.7). */
const HIDDEN =
	"the Claude Code and Codex launchers, the Docker controls and the system ports in the Running pane";

/** The two course profiles with the sentence that says what each shows. */
export const PROFILE_CHOICES: { value: CourseProfile; label: string; text: string }[] =
	[
		{
			value: "agentic",
			label: "Agentic",
			text: "Students see the whole interface, including Claude Code, Codex and the Docker controls.",
		},
		{
			value: "traditional",
			label: "Traditional",
			text: `Hides ${HIDDEN}.`,
		},
	];

export function profileLabel(profile: CourseProfile): string {
	return PROFILE_CHOICES.find((choice) => choice.value === profile)?.label ?? profile;
}

/** The administrator's version, where no choice carries its own sentence. */
export const PROFILE_SUMMARY = `Traditional hides ${HIDDEN}.`;

/** What hiding does not do, and when a change reaches students. */
export const PROFILE_NOTE =
	"Hiding never blocks anything: a student can still run any command in a terminal. Students see a change the next time they load the page or return to the window. A student in several courses gets the fullest interface among them.";
