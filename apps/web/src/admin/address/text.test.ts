import type { SiteJobView } from "@portikus/contracts";
import { describe, expect, test } from "vitest";
import { addressText, jobText } from "./text.js";

const job = (
	state: SiteJobView["state"],
	code: SiteJobView["code"] = null,
): SiteJobView => ({
	id: "6f0d5a4e-2b1c-4e8f-9a7d-3c2b1a0f9e8d",
	kind: "address",
	state,
	code,
	requestedAt: null,
	startedAt: null,
	finishedAt: null,
	trialEndsAt: null,
});
const target = { host: "code.example.edu", port: 443 };

test("addressText leaves out port 443 only", () => {
	expect(addressText(target)).toBe("https://code.example.edu");
	expect(addressText({ host: "a.example.edu", port: 8443 })).toBe(
		"https://a.example.edu:8443",
	);
});

describe("jobText", () => {
	test("says why a trial was put back", () => {
		expect(jobText(job("reverted", "trial_expired"), target)).toContain(
			"Nobody pressed Keep",
		);
		expect(jobText(job("reverted", "setup_failed"), target)).toContain("Setup failed");
		expect(jobText(job("reverted", "rolled_back"), target)).toContain("rolled back");
	});

	test("names the new address and a refusal's reason", () => {
		expect(jobText(job("kept"), target)).toContain("https://code.example.edu");
		expect(jobText(job("failed", "not_apt_install"), target)).toContain("apt");
		expect(jobText(job("failed", "write_failed"), null)).toContain(
			"Nothing was changed",
		);
	});
});
