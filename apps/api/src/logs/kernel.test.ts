import { describe, expect, test } from "vitest";
import { KERNEL_LINE_PATTERN, kernelLineMessage } from "./kernel.js";

const AT = new Date("2026-10-04T12:00:00Z");
const MAC = "MAC=00:16:3e:aa:bb:cc:00:16:3e:dd:ee:ff:08:00";
const tail = `IN=incusbr0 OUT=eth0 ${MAC} SRC=10.20.0.5 DST=203.0.113.9 LEN=60 PROTO=TCP SPT=41000 DPT=587 SYN`;

function parsed(message: string | null) {
	const line = kernelLineMessage(message, AT);
	return line === null ? null : (JSON.parse(line) as Record<string, unknown>);
}

describe("kernelLineMessage", () => {
	test("maps each prefix to a warn line with only the address and port", () => {
		expect(parsed(`portikus-ws-mail-blocked: ${tail}`)).toEqual({
			level: "warn",
			service: "network",
			time: AT.toISOString(),
			code: "WORKSPACE_MAIL_BLOCKED",
			msg: "Workspace outbound mail blocked",
			workspaceAddress: "10.20.0.5",
			destinationPort: 587,
		});
		expect(parsed(`portikus-ws-conn-limit: ${tail}`)?.msg).toBe(
			"Workspace hit the new-connection limit",
		);
		expect(parsed(`portikus-ws-packet-limit: ${tail}`)?.msg).toBe(
			"Workspace hit the packet limit",
		);
	});

	test("never keeps other fields of the kernel line", () => {
		const line = kernelLineMessage(`portikus-ws-mail-blocked: ${tail}`, AT) ?? "";
		expect(line).not.toContain("00:16:3e");
		expect(line).not.toContain("203.0.113.9");
		expect(line).not.toContain("41000");
		expect(line).not.toContain("incusbr0");
	});

	test("ignores every other kernel line, even one mentioning a prefix later", () => {
		expect(parsed(`nft: ${tail}`)).toBeNull();
		expect(parsed(`audit: portikus-ws-mail-blocked: ${tail}`)).toBeNull();
		expect(parsed(`portikus-ws-mail-blocked:${tail}`)).toBeNull();
		expect(parsed(null)).toBeNull();
	});

	test("a line without SRC or DPT keeps neither", () => {
		expect(parsed("portikus-ws-packet-limit: IN=incusbr0")).toEqual(
			expect.not.objectContaining({ workspaceAddress: expect.anything() }),
		);
	});

	test("the grep pattern matches the prefixes only at the start", () => {
		const re = new RegExp(KERNEL_LINE_PATTERN);
		expect(re.test(`portikus-ws-conn-limit: ${tail}`)).toBe(true);
		expect(re.test(`x portikus-ws-conn-limit: ${tail}`)).toBe(false);
	});
});
