import { expect, test } from "vitest";
import { MyLinks, UnlinkResponse } from "./links.js";

const COURSE_ID = "8d8b1f6e-3f2a-4c55-9a51-2f1f0b6c9e10";

const sso: MyLinks = { source: "sso", linkUntil: null, links: [], launch: null };

test("MyLinks carries the launching course identity, or null", () => {
	expect(MyLinks.parse(sso).launch).toBeNull();
	const launched = MyLinks.parse({
		...sso,
		launch: { courseUserId: COURSE_ID, platformName: "Mock LMS" },
	});
	expect(launched.launch).toEqual({
		courseUserId: COURSE_ID,
		platformName: "Mock LMS",
	});
});

test("MyLinks refuses a missing launch field and a bad course id", () => {
	const { launch: _launch, ...old } = sso;
	expect(() => MyLinks.parse(old)).toThrow();
	expect(() =>
		MyLinks.parse({ ...sso, launch: { courseUserId: "nope", platformName: "x" } }),
	).toThrow();
});

test("UnlinkResponse says whether the session ended", () => {
	expect(UnlinkResponse.parse({ signedOut: true }).signedOut).toBe(true);
	expect(() => UnlinkResponse.parse({})).toThrow();
});
