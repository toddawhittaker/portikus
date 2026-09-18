/**
 * What the file tree is showing right now: which directories are open and
 * whether hidden and generated files are on (SPEC.md §11.2, §11.3). It is
 * per project and per browser tab, and it is deliberately not saved: a tree
 * that reopens twenty directories on load helps nobody.
 */
import { create } from "zustand";
import { prunePaths, rewritePaths } from "./paths.js";

interface ProjectView {
	expanded: string[];
	showHidden: boolean;
}

const EMPTY: ProjectView = { expanded: [], showHidden: false };

interface FileViewState {
	byProject: Record<string, ProjectView>;
	toggleExpanded: (projectId: string, path: string) => void;
	setExpanded: (projectId: string, path: string, expanded: boolean) => void;
	toggleShowHidden: (projectId: string) => void;
	/** A deleted directory closes, and so does everything inside it. */
	pruneExpanded: (projectId: string, path: string) => void;
	/** A moved directory keeps its open state under its new path. */
	rewriteExpanded: (projectId: string, from: string, to: string) => void;
}

export const useFileViewStore = create<FileViewState>()((set) => ({
	byProject: {},

	toggleExpanded: (projectId, path) =>
		set((state) => {
			const view = state.byProject[projectId] ?? EMPTY;
			const open = view.expanded.includes(path);
			return {
				byProject: {
					...state.byProject,
					[projectId]: {
						...view,
						expanded: open
							? view.expanded.filter((item) => item !== path)
							: [...view.expanded, path],
					},
				},
			};
		}),

	setExpanded: (projectId, path, expanded) =>
		set((state) => {
			const view = state.byProject[projectId] ?? EMPTY;
			if (view.expanded.includes(path) === expanded) return state;
			return {
				byProject: {
					...state.byProject,
					[projectId]: {
						...view,
						expanded: expanded
							? [...view.expanded, path]
							: view.expanded.filter((item) => item !== path),
					},
				},
			};
		}),

	toggleShowHidden: (projectId) =>
		set((state) => {
			const view = state.byProject[projectId] ?? EMPTY;
			return {
				byProject: {
					...state.byProject,
					[projectId]: { ...view, showHidden: !view.showHidden },
				},
			};
		}),

	pruneExpanded: (projectId, path) =>
		set((state) => {
			const view = state.byProject[projectId] ?? EMPTY;
			return {
				byProject: {
					...state.byProject,
					[projectId]: { ...view, expanded: prunePaths(view.expanded, path) },
				},
			};
		}),

	rewriteExpanded: (projectId, from, to) =>
		set((state) => {
			const view = state.byProject[projectId] ?? EMPTY;
			return {
				byProject: {
					...state.byProject,
					[projectId]: { ...view, expanded: rewritePaths(view.expanded, from, to) },
				},
			};
		}),
}));

export function useExpanded(projectId: string): string[] {
	return useFileViewStore(
		(state) => state.byProject[projectId]?.expanded ?? EMPTY.expanded,
	);
}

export function useShowHidden(projectId: string): boolean {
	return useFileViewStore((state) => state.byProject[projectId]?.showHidden ?? false);
}
