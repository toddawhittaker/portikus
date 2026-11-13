/**
 * The scrollbar's ticks: the Git and status colours of
 * packages/ui/src/theme.css. Every scheme gets these for its mode, so the
 * marks match the Changes pane and the status colours whatever scheme a
 * student picks.
 */
const LIGHT: Record<string, string> = {
	"editorOverviewRuler.background": "#00000000",
	"editorOverviewRuler.border": "#00000000",
	"editorOverviewRuler.modifiedForeground": "#8a5a00",
	"editorOverviewRuler.addedForeground": "#2b7336",
	"editorOverviewRuler.deletedForeground": "#b0372b",
	"editorOverviewRuler.warningForeground": "#8a5a00",
	"editorOverviewRuler.errorForeground": "#b0372b",
	"editorOverviewRuler.findMatchForeground": "#1d6e67",
	"editorOverviewRuler.selectionHighlightForeground": "#1d6e6780",
	"editorOverviewRuler.wordHighlightForeground": "#1d6e6780",
	"editorOverviewRuler.bracketMatchForeground": "#00000000",
};

const DARK: Record<string, string> = {
	"editorOverviewRuler.background": "#00000000",
	"editorOverviewRuler.border": "#00000000",
	"editorOverviewRuler.modifiedForeground": "#f2c35a",
	"editorOverviewRuler.addedForeground": "#7fd18a",
	"editorOverviewRuler.deletedForeground": "#f59a8e",
	"editorOverviewRuler.warningForeground": "#f2c35a",
	"editorOverviewRuler.errorForeground": "#f59a8e",
	"editorOverviewRuler.findMatchForeground": "#5fcfbf",
	"editorOverviewRuler.selectionHighlightForeground": "#5fcfbf80",
	"editorOverviewRuler.wordHighlightForeground": "#5fcfbf80",
	"editorOverviewRuler.bracketMatchForeground": "#00000000",
};

export const OVERVIEW_RULER_COLOURS = { light: LIGHT, dark: DARK } as const;
