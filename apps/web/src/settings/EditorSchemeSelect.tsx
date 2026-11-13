import type { EditorScheme } from "@portikus/contracts";
import { Select } from "@portikus/ui";
import { EDITOR_SCHEME_LIST } from "../editor/schemes/index.js";

/** The editor colour scheme select in Appearance (SPEC.md §13.1). */
export function EditorSchemeSelect({
	label,
	value,
	onChange,
}: {
	label: string;
	value: EditorScheme;
	onChange: (value: EditorScheme) => void;
}) {
	return (
		<Select
			id="editor-colour-scheme"
			label={label}
			hint="The editor's colors. Light or dark still follows the setting above."
			options={EDITOR_SCHEME_LIST.map((scheme) => ({
				value: scheme.id,
				label: scheme.label,
			}))}
			value={value}
			onValueChange={(next) => onChange(next as EditorScheme)}
		/>
	);
}
