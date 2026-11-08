import { describe, expect, it } from "vitest";
import { cachedFormula } from "./formulaDependencies";

describe("existing formula field command formats", () => {
  it("recognizes %g and Hancom fixed-point %.Nf only when the cached value matches", () => {
    expect(cachedFormula("=SUM(A1:B1)??%g,;;30")).toEqual({ expression: "=SUM(A1:B1)", value: "30" });
    expect(cachedFormula("=A1*2??%g,;;1.5e+07")).toEqual({ expression: "=A1*2", value: "1.5e+07" });
    expect(cachedFormula("=AVG(ABOVE)??%.2f,;;2.00")).toEqual({ expression: "=AVG(ABOVE)", value: "2.00" });
    expect(cachedFormula("=SUM(ABOVE)??%.0f,;;14")).toEqual({ expression: "=SUM(ABOVE)", value: "14" });
    expect(cachedFormula("=A1-9??%.1f,;;-3.5")).toEqual({ expression: "=A1-9", value: "-3.5" });
    for (const command of [
      "=AVG(ABOVE)??%.2f,;;2", "=AVG(ABOVE)??%.2f,;;2.0", "=AVG(ABOVE)??%.0f,;;2.", "=AVG(ABOVE)??%.0f,;;2.5",
      "=AVG(ABOVE)??%.10f,;;2.0000000000", "=AVG(ABOVE)??%.2e,;;2.00", "=AVG(ABOVE)??%d,;;2", "=AVG(ABOVE)??%f,;;2.000000",
      "=AVG(ABOVE)??%.2f,;;+2.00", "=AVG(ABOVE)??%.2f,;;1e3", "AVG(ABOVE)??%.2f,;;2.00", "=??%.2f,;;2.00",
      "=" + "1".repeat(257) + "??%g,;;1", "=A1??%g,;;x", 42, null,
    ]) expect(cachedFormula(command), String(command)).toBeNull();
  });
});
