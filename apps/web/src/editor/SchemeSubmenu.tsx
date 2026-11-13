import { EDITOR_SETTINGS_DEFAULTS, type EditorScheme } from "@portikus/contracts";
import { MenuRadioGroup, MenuRadioItem, MenuSub } from "@portikus/ui";
import { EDITOR_SCHEME_LIST } from "./schemes/index.js";
import { useEditorSettings, useUpdateEditorSettings } from "./settingsQueries.js";

/**
 * The "Color scheme" submenu of a code editor's actions menu: the same
 * `editorScheme` setting Settings saves, one tick on the scheme in use
 * (SPEC.md §13.1, §25.8).
 */
export function SchemeSubmenu() {
	const settings = useEditorSettings();
	const update = useUpdateEditorSettings();
	const current = settings.data?.editorScheme ?? EDITOR_SETTINGS_DEFAULTS.editorScheme;
	return (
		<MenuSub label="Color scheme" testId="editor-scheme-menu">
			<MenuRadioGroup
				label="Color scheme"
				value={current}
				onValueChange={(value) =>
					update.mutate({ editorScheme: value as EditorScheme })
				}
			>
				{EDITOR_SCHEME_LIST.map((scheme) => (
					<MenuRadioItem
						key={scheme.id}
						value={scheme.id}
						testId={`editor-scheme-${scheme.id}`}
					>
						{scheme.label}
					</MenuRadioItem>
				))}
			</MenuRadioGroup>
		</MenuSub>
	);
}
