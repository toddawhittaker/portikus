import { afterEach, describe, expect, test, vi } from "vitest";
import type { Operation, OperationRecords } from "./types.js";

function operation(name: string): Operation {
	return {
		name,
		description: "A fake operation.",
		risk: "read",
		audience: "staff",
		tool: false,
		input: {},
	};
}

/** Load the catalog with each family's records replaced. */
async function loadCatalog(families: {
	people?: OperationRecords;
	workspaces?: OperationRecords;
}) {
	vi.resetModules();
	vi.doMock("./families/people.js", () => ({
		operations: families.people ?? {},
		pending: ["GET /admin/users"],
	}));
	vi.doMock("./families/workspaces.js", () => ({
		operations: families.workspaces ?? {},
		pending: [],
	}));
	vi.doMock("./families/site.js", () => ({ operations: {}, pending: [] }));
	vi.doMock("./families/courses.js", () => ({ operations: {}, pending: [] }));
	return import("./index.js");
}

afterEach(() => {
	vi.doUnmock("./families/people.js");
	vi.doUnmock("./families/workspaces.js");
	vi.doUnmock("./families/site.js");
	vi.doUnmock("./families/courses.js");
	vi.resetModules();
});

describe("the merged catalog", () => {
	test("joins every family and collects their pending lists", async () => {
		const catalog = await loadCatalog({
			people: { "GET /admin/settings": operation("settings.get") },
			workspaces: { "GET /workspaces/:id": operation("workspaces.get") },
		});
		expect(Object.keys(catalog.OPERATIONS).sort()).toEqual([
			"GET /admin/settings",
			"GET /workspaces/:id",
		]);
		expect(catalog.PENDING).toEqual(["GET /admin/users"]);
	});

	test("finds an operation by key, by the key's HEAD twin, and by name", async () => {
		const settings = operation("settings.get");
		const catalog = await loadCatalog({ people: { "GET /admin/settings": settings } });
		expect(catalog.operationByKey("GET /admin/settings")).toBe(settings);
		expect(catalog.operationByKey("HEAD /admin/settings")).toBe(settings);
		expect(catalog.operationByKey("PUT /admin/settings")).toBeUndefined();
		expect(catalog.operationByName("settings.get")).toEqual({
			key: "GET /admin/settings",
			operation: settings,
		});
		expect(catalog.operationByName("settings.nope")).toBeUndefined();
	});

	test("refuses a route given two records", async () => {
		await expect(
			loadCatalog({
				people: { "GET /admin/settings": operation("settings.get") },
				workspaces: { "GET /admin/settings": operation("settings.other") },
			}),
		).rejects.toThrow("GET /admin/settings has two records");
	});

	test("refuses a name used twice", async () => {
		await expect(
			loadCatalog({
				people: { "GET /admin/settings": operation("settings.get") },
				workspaces: { "GET /workspaces/:id": operation("settings.get") },
			}),
		).rejects.toThrow("settings.get is used twice");
	});
});
