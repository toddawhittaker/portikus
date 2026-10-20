/**
 * The code-help manager of each project open on this page. Monaco's
 * providers and opener are global, so they find a model's manager here.
 */
import type { CodeHelpManager } from "./manager.js";

const managers = new Map<string, CodeHelpManager>();

export function managerFor(projectId: string): CodeHelpManager | undefined {
	return managers.get(projectId);
}

export function addManager(projectId: string, manager: CodeHelpManager): void {
	managers.set(projectId, manager);
}

export function removeManager(projectId: string, manager: CodeHelpManager): void {
	if (managers.get(projectId) === manager) managers.delete(projectId);
}
