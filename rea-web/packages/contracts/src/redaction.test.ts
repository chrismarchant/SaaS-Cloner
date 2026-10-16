import { describe, expect, it } from "vitest";
import {
  createRedactor,
  DEFAULT_SECRET_ENV_NAMES,
  REDACTED,
  redactorFromEnvironment,
} from "./redaction.js";

describe("createRedactor.redactText", () => {
  const redactor = createRedactor({
    secretNames: ["REA_WEB_S3_SECRET_ACCESS_KEY", "DB_PASSWORD"],
    secretValues: ["hunter2hunter2", "short"],
  });

  it("redacts configured secret values of at least six characters", () => {
    expect(redactor.redactText("key=hunter2hunter2 ok")).toBe(
      `key=${REDACTED} ok`,
    );
    expect(redactor.redactText("short stays")).toBe("short stays");
  });

  it("redacts NAME=value and NAME: value for configured names", () => {
    expect(
      redactor.redactText('REA_WEB_S3_SECRET_ACCESS_KEY="abc def" tail'),
    ).toBe(`REA_WEB_S3_SECRET_ACCESS_KEY=${REDACTED} tail`);
    expect(redactor.redactText("DB_PASSWORD: p@ss,next")).toBe(
      `DB_PASSWORD=${REDACTED},next`,
    );
    expect(redactor.redactText("OTHER_NAME=visible")).toBe(
      "OTHER_NAME=visible",
    );
  });

  it("redacts transport credentials without configuration", () => {
    expect(
      redactor.redactText("Authorization: Bearer abcdefghijklmnopqrstuvwxyz"),
    ).toBe(`Authorization: Bearer ${REDACTED}`);
    expect(redactor.redactText("Cookie: rea_web_session=abc; other=1")).toBe(
      `Cookie: ${REDACTED}`,
    );
    expect(redactor.redactText("https://user:pass@host.example/path")).toBe(
      `https://${REDACTED}@host.example/path`,
    );
    expect(
      redactor.redactText("sk-ant-api03-ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789"),
    ).toBe(`sk-ant-api${REDACTED}`);
    expect(redactor.redactText("x-api-key: 12345abcdef")).toBe(
      `x-api-key: ${REDACTED}`,
    );
  });
});

describe("createRedactor.redactValue", () => {
  const redactor = createRedactor({
    secretNames: ["MY_SECRET"],
    secretValues: [],
  });

  it("redacts secret-like keys regardless of value and recurses", () => {
    expect(
      redactor.redactValue({
        password: "x",
        token: "y",
        apiKey: "z",
        MY_SECRET: "w",
        nested: [{ private_key: "k", name: "fine" }],
        note: "plain",
      }),
    ).toEqual({
      password: REDACTED,
      token: REDACTED,
      apiKey: REDACTED,
      MY_SECRET: REDACTED,
      nested: [{ private_key: REDACTED, name: "fine" }],
      note: "plain",
    });
  });

  it("leaves numbers, booleans and null unchanged", () => {
    expect(redactor.redactValue({ n: 1, b: true, z: null })).toEqual({
      n: 1,
      b: true,
      z: null,
    });
  });
});

describe("redactorFromEnvironment", () => {
  it("collects values by name from the environment and redacts them", () => {
    const redactor = redactorFromEnvironment(
      { REA_WEB_ANTHROPIC_API_KEY: "sekret-value-123", UNRELATED: "keep" },
      DEFAULT_SECRET_ENV_NAMES,
    );
    expect(redactor.redactText("sent sekret-value-123 and keep")).toBe(
      `sent ${REDACTED} and keep`,
    );
  });
});
