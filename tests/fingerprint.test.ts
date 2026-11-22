import { describe, expect, it } from "vitest";
import { diffFingerprints, fingerprint } from "../flywheel/fingerprint";

describe("fingerprint", () => {
  const base = fingerprint({ model: "m1", judgeModel: "j1" });
  it("is stable", () => {
    expect(fingerprint({ model: "m1", judgeModel: "j1" }).hashes).toEqual(base.hashes);
  });
  it("detects each kind of change", () => {
    expect(diffFingerprints(base, fingerprint({ model: "m2", judgeModel: "j1" }))).toEqual(["model"]);
    expect(diffFingerprints(base, fingerprint({ model: "m1", judgeModel: "j2" }))).toEqual(["judge"]);
    expect(diffFingerprints(base, fingerprint({ model: "m1", judgeModel: "j1", systemPrompt: "different" }))).toEqual(["prompt"]);
    expect(diffFingerprints(base, fingerprint({ model: "m1", judgeModel: "j1", toolDescriptions: { runQuery: "x" } }))).toEqual(["tools"]);
  });
  it("records the artifacts needed for ablation", () => {
    expect(base.artifacts.systemPrompt).toContain("Business glossary");
    expect(Object.keys(base.artifacts.toolDescriptions)).toEqual(["listTables", "describeTable", "runQuery", "submitAnswer"]);
  });
});
