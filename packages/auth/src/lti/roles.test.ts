import { describe, expect, test } from "vitest";
import { mapLtiRoles } from "./roles.js";

const LIS = "http://purl.imsglobal.org/vocab/lis/v2/";

describe("mapLtiRoles", () => {
	test.each([
		[[`${LIS}membership#Instructor`], "instructor"],
		[[`${LIS}membership#TeachingAssistant`], "instructor"],
		[[`${LIS}membership/Instructor#TeachingAssistant`], "instructor"],
		[[`${LIS}membership#ContentDeveloper`], "instructor"],
		[[`${LIS}institution/person#Administrator`], "instructor"],
		[["Instructor"], "instructor"],
		[["TeachingAssistant"], "instructor"],
		[[`${LIS}membership#Learner`], "student"],
		[["Learner"], "student"],
		[[`${LIS}membership#Mentor`], "student"],
		[[`${LIS}system/person#SysAdmin`], "student"],
		[[`${LIS}institution/person#Student`, `${LIS}membership#Instructor`], "instructor"],
		[[], "student"],
		[[42, null], "student"],
		[undefined, "student"],
		["Instructor", "student"],
	])("%j maps to %s", (roles, expected) => {
		expect(mapLtiRoles(roles)).toBe(expected);
	});

	test("never grants administrator", () => {
		expect(mapLtiRoles(["Administrator", `${LIS}system/person#Administrator`])).toBe(
			"instructor",
		);
	});
});
