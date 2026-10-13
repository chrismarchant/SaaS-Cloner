import { describe, expect, it } from "vitest";
import {
  DEFAULT_APPROVAL_EFFECTS,
  executionPolicySchema,
  type JobEvent,
} from "@rea-web/contracts/browser";
import {
  mergeEvents,
  parseEventData,
  parseStreamEnd,
  summariseEvent,
} from "../src/lib/events";
import {
  formatBytes,
  formatDuration,
  plural,
  safeFileName,
} from "../src/lib/format";
import {
  childEntries,
  describeValue,
  isUuid,
  normalizedResultOf,
  prettyJson,
} from "../src/lib/json";
import { defaultPolicyDraft, policyFromDraft } from "../src/lib/policy";
import { evidenceOptions } from "../src/routes/investigation/shared";
import { retainedEvidenceJson } from "../src/components/EvidencePicker";

const event = (
  seq: number,
  kind: JobEvent["kind"],
  payload = {},
): JobEvent => ({
  job_id: "j",
  seq,
  kind,
  payload,
  created_at: "2026-01-01T00:00:00Z",
});

describe("event merging", () => {
  it("orders by seq and drops replayed frames", () => {
    const first = [event(1, "job.created"), event(3, "job.progress")];
    const merged = mergeEvents(first, [
      event(2, "job.claimed"),
      event(3, "job.progress"),
    ]);
    expect(merged.map((e) => e.seq)).toEqual([1, 2, 3]);
  });

  it("parses frames against the event schema", () => {
    expect(parseEventData(JSON.stringify(event(1, "job.created")))?.seq).toBe(
      1,
    );
    expect(parseEventData('{"seq":1}')).toBeNull();
    expect(parseEventData("not json")).toBeNull();
  });

  it("parses stream_end", () => {
    expect(
      parseStreamEnd('{"job_id":"j","state":"succeeded","last_seq":9}'),
    ).toEqual({
      jobId: "j",
      state: "succeeded",
      lastSeq: 9,
    });
    expect(parseStreamEnd("{}")).toBeNull();
  });

  it("summarises only fields the event carries", () => {
    expect(summariseEvent(event(1, "job.created"))).toBe("");
    expect(
      summariseEvent(
        event(4, "job.tool_call", {
          tool: "open_binary",
          seq: 2,
          is_error: true,
        }),
      ),
    ).toBe("tool: open_binary · call #2 · error result");
    expect(
      summariseEvent(
        event(2, "job.transition", { from: "queued", to: "preparing" }),
      ),
    ).toBe("queued -> preparing");
  });
});

describe("policy draft", () => {
  it("starts from the contract defaults", () => {
    const draft = defaultPolicyDraft();
    const defaults = executionPolicySchema.parse({});
    expect(draft.mode).toBe("static_only");
    expect(draft.approval).toEqual([...DEFAULT_APPROVAL_EFFECTS]);
    expect(draft.allowed).toEqual(defaults.allowed_effects);
    expect(draft.modelFollowUp).toBe(defaults.model_follow_up);
  });

  it("produces a request policy the contract accepts", () => {
    const draft = defaultPolicyDraft();
    draft.modelFollowUp = false;
    draft.budget = { tool_calls: "40", wall_ms: "" };
    const result = policyFromDraft(draft);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.policy).toMatchObject({
      mode: "static_only",
      model_follow_up: false,
      budget: { tool_calls: 40 },
    });
    expect(executionPolicySchema.parse(result.policy).budget).toEqual({
      tool_calls: 40,
    });
  });

  it("reports invalid numbers by field", () => {
    const draft = defaultPolicyDraft();
    draft.maxRounds = "99";
    draft.budget = { wall_ms: "abc", disk_bytes: "0" };
    const result = policyFromDraft(draft);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(Object.keys(result.errors).sort()).toEqual([
      "disk_bytes",
      "max_follow_up_rounds",
      "wall_ms",
    ]);
  });
});

describe("json helpers", () => {
  it("caps pretty output", () => {
    const small = prettyJson({ a: 1 }, 100);
    expect(small.truncated).toBe(false);
    const big = prettyJson({ text: "x".repeat(500) }, 100);
    expect(big.truncated).toBe(true);
    expect(big.text).toHaveLength(100);
    expect(big.totalChars).toBeGreaterThan(500);
  });

  it("describes values and lists children", () => {
    expect(describeValue([1, 2])).toBe("array, 2 items");
    expect(describeValue({ a: 1 })).toBe("object, 1 key");
    expect(describeValue("x")).toBe('"x"');
    expect(describeValue(null)).toBe("null");
    expect(childEntries({ a: 1, b: 2 })).toEqual([
      ["a", 1],
      ["b", 2],
    ]);
    expect(childEntries(["x"])).toEqual([["0", "x"]]);
  });

  it("finds the normalized result only when the producer returned one", () => {
    expect(
      normalizedResultOf({
        structuredContent: { normalized_result: { a: 1 } },
      }),
    ).toEqual({ a: 1 });
    expect(normalizedResultOf({ structuredContent: {} })).toBeUndefined();
    expect(normalizedResultOf(null)).toBeUndefined();
  });

  it("accepts only UUID shaped ids for links", () => {
    expect(isUuid("01970000-0000-7000-8000-000000000001")).toBe(true);
    expect(isUuid("../../etc")).toBe(false);
    expect(isUuid("javascript:alert(1)")).toBe(false);
  });
});

describe("formatting", () => {
  it("formats sizes and durations", () => {
    expect(formatBytes(512)).toBe("512 B");
    expect(formatBytes(2 * 1024 * 1024)).toBe("2.00 MiB");
    expect(formatBytes(null)).toBe("unknown");
    expect(formatDuration(250)).toBe("250 ms");
    expect(formatDuration(65_000)).toBe("1 min 5 s");
    expect(plural(1, "item")).toBe("1 item");
    expect(plural(2, "item")).toBe("2 items");
  });

  it("sanitises download names", () => {
    const hostile = safeFileName("../../x y.zip", "f");
    expect(hostile).toBe("_._x_y.zip");
    expect(hostile).not.toMatch(/[/\\]|\.\./u);
    expect(safeFileName("<>", "fallback")).toBe("_");
    expect(safeFileName("", "fallback")).toBe("fallback");
  });
});

describe("evidence references", () => {
  it("offers only evidence ids this investigation recorded", () => {
    const calls = [
      { seq: 1, tool_name: "open_binary", evidence_id: null },
      {
        seq: 2,
        tool_name: "analyze_javascript_application",
        evidence_id: `ev_${"a".repeat(64)}`,
      },
    ] as never[];
    const options = evidenceOptions(calls);
    expect(options).toHaveLength(1);
    expect(options[0]?.evidenceId).toBe(`ev_${"a".repeat(64)}`);
    expect(options[0]?.label).toContain("#2 analyze_javascript_application");
  });

  it("inserts the retained-evidence reference shape", () => {
    expect(JSON.parse(retainedEvidenceJson("ev_x"))).toEqual({
      kind: "retained-evidence",
      evidence_id: "ev_x",
    });
  });
});
