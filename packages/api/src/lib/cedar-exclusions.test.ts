import { describe, expect, it } from "vitest";
import { withExclusions } from "./cedar-exclusions";

describe("withExclusions", () => {
  it("leaves a policy as written when nobody is excluded", () => {
    const p = "permit(principal, action, resource);";
    expect(withExclusions(p, [])).toBe(p);
  });

  it("adds one unless clause before the final semicolon", () => {
    expect(
      withExclusions(
        'permit(principal, action, resource) when { context.method == "GET" };',
        ["a", "b"],
      ),
    ).toBe(
      'permit(principal, action, resource) when { context.method == "GET" }\nunless { principal in [OneCLI::Agent::"a", OneCLI::Agent::"b"] };',
    );
  });

  it("drops trailing comments and keeps annotations", () => {
    const out = withExclusions(
      '@rate_limit("1/minute")\nforbid(principal, action, resource);\n// note\n',
      ["a"],
    );
    expect(
      out.startsWith(
        '@rate_limit("1/minute")\nforbid(principal, action, resource)',
      ),
    ).toBe(true);
    expect(out.endsWith('unless { principal in [OneCLI::Agent::"a"] };')).toBe(
      true,
    );
    expect(out).not.toContain("// note");
  });

  it("never lets an id break out of its string", () => {
    expect(
      withExclusions("permit(principal, action, resource);", [
        'x"] }; permit(principal, action, resource); //',
      ]),
    ).toContain(
      'OneCLI::Agent::"x] }; permit(principal, action, resource); //"',
    );
  });
});
