import { describe, expect, it } from "vitest";
import { FILTER_EXAMPLES, FILTER_SYNTAX } from "../packages/filter-syntax/src/index";

describe("v4.3 filter documentation contract", () => {
  it("documents Create Glob question mark as one character", () => expect(FILTER_SYNTAX.glob.question).toContain("exactly one"));
  it("keeps legacy addr syntax distinct from Glob", () => expect(FILTER_SYNTAX.legacyAddress).toContain("substring"));
  it("includes examples for whitelist, blacklist, and legacy address filters", () => {
    const examples = FILTER_EXAMPLES.map(x => x.expression);
    expect(examples).toContain("#warehouse");
    expect(examples).toContain("!#warehouse");
    expect(examples).toContain("addr:warehouse");
  });
});
