import { describe, expect, it } from "vitest";
import { toProbeKey, resolveProbe } from "../../src/probes/index";
import { probeActualyze } from "../../src/probes/actualyze";

describe("probe registry", () => {
  it("resolves the actualyze ID", async () => {
    await expect(resolveProbe("actualyze", "https://a.test")).resolves.toEqual({
      probe: probeActualyze,
      key: "actualyze",
    });
  });

  it("rejects unknown IDs and inherited object keys", async () => {
    for (const id of ["nope", "constructor", "__proto__", "toString"]) {
      expect(toProbeKey(id)).toBeUndefined();
      await expect(resolveProbe(id, "https://a.test")).resolves.toEqual({
        probe: undefined,
      });
    }
  });

  it("maps the actualyze owner through auto detection", async () => {
    await expect(
      resolveProbe("auto", "https://a.test", undefined, {
        modelsResponse: [
          { id: "m", object: "model", created: 1, owned_by: "actualyze" },
        ],
      }),
    ).resolves.toEqual({
      probe: probeActualyze,
      key: "actualyze",
      detectedServer: "actualyze",
    });
  });
});
