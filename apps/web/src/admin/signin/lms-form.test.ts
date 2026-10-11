import type { AdminLtiPlatform, OperatorLtiPlatform } from "@portikus/contracts";
import { describe, expect, test } from "vitest";
import { checkDraft, draftOf, EMPTY_DRAFT } from "./lms-form.js";

const canvas: AdminLtiPlatform = {
	name: "Canvas",
	issuer: "https://canvas.example.edu",
	clientId: "c1",
	authLoginUrl: "https://canvas.example.edu/auth",
	keysetUrl: "https://canvas.example.edu/jwks",
	deploymentIds: ["d1", "d2"],
	mock: false,
};
const operator: OperatorLtiPlatform = {
	...canvas,
	name: "Op",
	issuer: "https://op.example.edu",
	clientId: "o1",
};

describe("checking the platform dialog", () => {
	test("a good draft becomes a platform, with trimmed text and one ID per line", () => {
		const draft = {
			...draftOf(canvas),
			name: "  Canvas ",
			deploymentIds: "d1\n\n d2 \n",
		};
		expect(checkDraft(draft, [], [])).toEqual({ platform: canvas });
	});

	test("an empty draft names every required field", () => {
		const result = checkDraft(EMPTY_DRAFT, [], []);
		expect(Object.keys("errors" in result ? result.errors : {}).sort()).toEqual([
			"authLoginUrl",
			"clientId",
			"deploymentIds",
			"issuer",
			"keysetUrl",
			"name",
		]);
	});

	test("http, a keyset port and a mock-like address are refused", () => {
		const result = checkDraft(
			{
				...draftOf(canvas),
				issuer: "http://canvas.example.edu",
				keysetUrl: "https://canvas.example.edu:8443/jwks",
			},
			[],
			[],
		);
		expect("errors" in result && Object.keys(result.errors).sort()).toEqual([
			"issuer",
			"keysetUrl",
		]);
	});

	test("a name or pair another platform holds is refused, the operator's too", () => {
		const sameName = checkDraft({ ...draftOf(canvas), clientId: "x" }, [canvas], []);
		expect("errors" in sameName && sameName.errors.name).toMatch(
			/already has this name/,
		);
		const samePair = checkDraft(
			{ ...draftOf(canvas), name: "Other" },
			[],
			[{ ...operator, issuer: canvas.issuer, clientId: canvas.clientId }],
		);
		expect("errors" in samePair && samePair.errors.clientId).toMatch(
			/already registered/,
		);
	});
});
