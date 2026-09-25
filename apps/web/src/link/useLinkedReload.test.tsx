/**
 * Every Portikus tab but the link tab itself reloads when a link finishes
 * (docs/archive/epics/EPIC-13-1.md, "The flow" step 4), with or without Settings open.
 */
import { renderHook, waitFor } from "@testing-library/react";
import { afterEach, expect, test, vi } from "vitest";
import { announceLink } from "./channel.js";
import { useLinkedReload } from "./useLinkedReload.js";

afterEach(() => vi.unstubAllGlobals());

function stubLocation(pathname: string) {
	const assign = vi.fn();
	vi.stubGlobal("location", { ...window.location, pathname, assign });
	return assign;
}

test("a workspace tab reloads into the new account when a link finishes", async () => {
	const assign = stubLocation("/workspaces/w1");
	renderHook(() => useLinkedReload());

	announceLink({ type: "cancelled" });
	announceLink({ type: "linked" });

	await waitFor(() => expect(assign).toHaveBeenCalledWith("/"));
	expect(assign).toHaveBeenCalledTimes(1);
});

test("the link tab does not reload on its own message", async () => {
	const assign = stubLocation("/link");
	renderHook(() => useLinkedReload());
	const heard = vi.fn();
	const probe = new BroadcastChannel("portikus-link");
	probe.onmessage = heard;

	announceLink({ type: "linked" });

	await waitFor(() => expect(heard).toHaveBeenCalled());
	probe.close();
	expect(assign).not.toHaveBeenCalled();
});
