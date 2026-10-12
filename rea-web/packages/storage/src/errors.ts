export class ObjectNotFoundError extends Error {
  readonly key: string;
  constructor(key: string) {
    super("Object not found");
    this.name = "ObjectNotFoundError";
    this.key = key;
  }
}

export class InvalidObjectKeyError extends Error {
  readonly key: string;
  readonly reason: string;
  constructor(key: string, reason: string) {
    // The key is hostile input by definition; keep it out of the message.
    super(`Invalid object key: ${reason}`);
    this.name = "InvalidObjectKeyError";
    this.key = key;
    this.reason = reason;
  }
}

export class ObjectTooLargeError extends Error {
  readonly key: string;
  readonly limit: number;
  constructor(key: string, limit: number) {
    super(`Object exceeds the ${limit} byte limit`);
    this.name = "ObjectTooLargeError";
    this.key = key;
    this.limit = limit;
  }
}

export class ObjectIntegrityError extends Error {
  readonly key: string;
  readonly expected: string;
  readonly actual: string;
  constructor(key: string, expected: string, actual: string) {
    super("Object integrity check failed");
    this.name = "ObjectIntegrityError";
    this.key = key;
    this.expected = expected;
    this.actual = actual;
  }
}

/** An error with the standard `AbortError` name, as thrown by Node APIs. */
export const makeAbortError = (signal?: AbortSignal): Error => {
  const error = new Error("The operation was aborted", {
    cause: signal?.reason,
  });
  error.name = "AbortError";
  return error;
};

export const isAbortError = (error: unknown): boolean =>
  error instanceof Error && error.name === "AbortError";
