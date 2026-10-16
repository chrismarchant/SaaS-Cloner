import { createHash } from "node:crypto";
import {
  createServer,
  type IncomingMessage,
  type ServerResponse,
} from "node:http";
import type { AddressInfo } from "node:net";

/**
 * In-process S3 for the preservation tests: path-style, several buckets,
 * ListObjectsV2 (with a page-size cap and optional URL-encoded keys),
 * GetObject, and switches for the failures the collector must survive.
 * Adapted from packages/storage/test/mockS3.ts.
 */
export interface MockObject {
  body: Buffer;
  contentType: string;
  lastModified: Date;
  etag: string;
}

export interface MockS3Options {
  /** Largest page ListObjectsV2 returns, whatever max-keys asks for. */
  pageSize?: number;
  /** Path before the bucket (e.g. "/storage/v1/s3"). */
  basePath?: string;
  /** Answer `encoding-type=url` like S3 does. Default true. */
  encodeKeys?: boolean;
}

export interface MockS3 {
  readonly endpoint: string;
  readonly buckets: Map<string, Map<string, MockObject>>;
  /** `METHOD /path?query` for every request, in arrival order. */
  readonly requests: string[];
  /** Access key ids seen in Authorization headers. */
  readonly accessKeyIds: Set<string>;
  /** Everything the SDK sent in the Authorization header, verbatim. */
  readonly authorizations: string[];
  /** Fail every request with 403 AccessDenied. */
  denyAll: boolean;
  /** Buckets whose listing answers 403. */
  denyList: Set<string>;
  /** `bucket/key` whose GetObject answers 403. */
  denyGet: Set<string>;
  /** `bucket/key` whose GetObject sends half the body and drops the socket. */
  dropGet: Set<string>;
  /** `bucket/key` -> size the listing reports instead of the real one. */
  listedSize: Map<string, number>;
  /** Text of the AccessDenied message. */
  denyMessage: string;
  /** Called with each request line before it is answered. */
  onRequest: ((line: string) => void) | undefined;
  put(bucket: string, key: string, body: Buffer | string, type?: string): void;
  close(): Promise<void>;
}

const md5 = (data: Buffer): string =>
  createHash("md5").update(data).digest("hex");

const escapeXml = (value: string): string =>
  value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");

const s3Encode = (key: string): string =>
  encodeURIComponent(key).replaceAll("%2F", "/").replaceAll("%20", "+");

const sendXml = (res: ServerResponse, status: number, xml: string): void => {
  res.writeHead(status, { "content-type": "application/xml" });
  res.end(`<?xml version="1.0" encoding="UTF-8"?>${xml}`);
};

const sendError = (
  res: ServerResponse,
  status: number,
  code: string,
  message: string = code,
): void =>
  sendXml(
    res,
    status,
    `<Error><Code>${code}</Code><Message>${escapeXml(message)}</Message></Error>`,
  );

const byCodepoint = (a: string, b: string): number =>
  a < b ? -1 : a > b ? 1 : 0;

export async function startMockS3(
  bucketNames: readonly string[],
  options: MockS3Options = {},
): Promise<MockS3> {
  const buckets = new Map<string, Map<string, MockObject>>(
    bucketNames.map((name) => [name, new Map()]),
  );
  const requests: string[] = [];
  const accessKeyIds = new Set<string>();
  const authorizations: string[] = [];
  const basePath = options.basePath ?? "";
  const pageSize = options.pageSize ?? 1000;
  const encodeKeys = options.encodeKeys ?? true;
  const state: Pick<
    MockS3,
    | "denyAll"
    | "denyList"
    | "denyGet"
    | "dropGet"
    | "listedSize"
    | "denyMessage"
    | "onRequest"
  > = {
    denyAll: false,
    denyList: new Set(),
    denyGet: new Set(),
    dropGet: new Set(),
    listedSize: new Map(),
    denyMessage: "AccessDenied",
    onRequest: undefined,
  };
  const denied = (res: ServerResponse): void =>
    sendError(res, 403, "AccessDenied", state.denyMessage);

  const list = (
    bucket: string,
    objects: Map<string, MockObject>,
    url: URL,
    res: ServerResponse,
  ): void => {
    const prefix = url.searchParams.get("prefix") ?? "";
    const maxKeys = Math.min(
      Number(url.searchParams.get("max-keys") ?? "1000"),
      pageSize,
    );
    const token = url.searchParams.get("continuation-token");
    const after =
      token === null ? "" : Buffer.from(token, "base64url").toString("utf8");
    const matching = [...objects.keys()]
      .filter(
        (key) => key.startsWith(prefix) && (token === null || key > after),
      )
      .sort(byCodepoint);
    const page = matching.slice(0, maxKeys);
    const truncated = matching.length > page.length;
    const last = page[page.length - 1];
    const encoding =
      encodeKeys && url.searchParams.get("encoding-type") === "url";
    const show = (key: string): string =>
      escapeXml(encoding ? s3Encode(key) : key);
    const contents = page
      .map((key) => {
        const object = objects.get(key);
        return (
          `<Contents><Key>${show(key)}</Key>` +
          `<LastModified>${object?.lastModified.toISOString() ?? ""}</LastModified>` +
          `<ETag>${escapeXml(object?.etag ?? "")}</ETag>` +
          `<Size>${state.listedSize.get(`${bucket}/${key}`) ?? object?.body.byteLength ?? 0}</Size>` +
          "<StorageClass>STANDARD</StorageClass></Contents>"
        );
      })
      .join("");
    sendXml(
      res,
      200,
      `<ListBucketResult><Name>${bucket}</Name><Prefix>${show(prefix)}</Prefix>` +
        `<KeyCount>${page.length}</KeyCount><MaxKeys>${maxKeys}</MaxKeys>` +
        (encoding ? "<EncodingType>url</EncodingType>" : "") +
        `<IsTruncated>${truncated}</IsTruncated>` +
        (truncated && last !== undefined
          ? `<NextContinuationToken>${Buffer.from(last).toString("base64url")}</NextContinuationToken>`
          : "") +
        `${contents}</ListBucketResult>`,
    );
  };

  const handle = (req: IncomingMessage, res: ServerResponse): void => {
    const method = req.method ?? "GET";
    const url = new URL(req.url ?? "/", "http://mock.invalid");
    url.searchParams.delete("x-id");
    requests.push(`${method} ${url.pathname}${url.search}`);
    state.onRequest?.(`${method} ${url.pathname}${url.search}`);
    const authorization = req.headers["authorization"];
    if (typeof authorization === "string") {
      authorizations.push(authorization);
      const match = /Credential=([^/]+)\//u.exec(authorization);
      if (match?.[1] !== undefined) accessKeyIds.add(match[1]);
    }
    if (state.denyAll) return denied(res);
    if (!url.pathname.startsWith(`${basePath}/`))
      return sendError(res, 404, "NoSuchBucket");
    const rest = url.pathname.slice(basePath.length + 1);
    const slash = rest.indexOf("/");
    const bucket = decodeURIComponent(
      slash === -1 ? rest : rest.slice(0, slash),
    );
    const key = slash === -1 ? "" : decodeURIComponent(rest.slice(slash + 1));
    const objects = buckets.get(bucket);
    if (objects === undefined) return sendError(res, 404, "NoSuchBucket");
    if (key === "") {
      if (state.denyList.has(bucket)) return denied(res);
      if (method === "GET" && url.searchParams.get("list-type") === "2")
        return list(bucket, objects, url, res);
      return sendError(res, 501, "NotImplemented");
    }
    if (method !== "GET" && method !== "HEAD")
      return sendError(res, 501, "NotImplemented");
    if (state.denyGet.has(`${bucket}/${key}`)) return denied(res);
    const object = objects.get(key);
    if (object === undefined) return sendError(res, 404, "NoSuchKey");
    res.writeHead(200, {
      "content-length": String(object.body.byteLength),
      "content-type": object.contentType,
      "last-modified": object.lastModified.toUTCString(),
      etag: object.etag,
    });
    if (state.dropGet.has(`${bucket}/${key}`)) {
      res.write(object.body.subarray(0, Math.max(1, object.body.length >> 1)));
      setTimeout(() => res.socket?.destroy(), 20);
      return;
    }
    res.end(method === "GET" ? object.body : undefined);
  };

  const server = createServer(handle);
  await new Promise<void>((resolve) => {
    server.listen(0, "127.0.0.1", resolve);
  });
  const { port } = server.address() as AddressInfo;
  return {
    endpoint: `http://127.0.0.1:${port}${basePath}`,
    buckets,
    requests,
    accessKeyIds,
    authorizations,
    get denyAll() {
      return state.denyAll;
    },
    set denyAll(value: boolean) {
      state.denyAll = value;
    },
    denyList: state.denyList,
    denyGet: state.denyGet,
    dropGet: state.dropGet,
    listedSize: state.listedSize,
    get denyMessage() {
      return state.denyMessage;
    },
    set denyMessage(value: string) {
      state.denyMessage = value;
    },
    get onRequest() {
      return state.onRequest;
    },
    set onRequest(value: ((line: string) => void) | undefined) {
      state.onRequest = value;
    },
    put: (bucket, key, body, type = "application/octet-stream") => {
      const data = typeof body === "string" ? Buffer.from(body) : body;
      const objects = buckets.get(bucket);
      if (objects === undefined) throw new Error(`no bucket ${bucket}`);
      objects.set(key, {
        body: data,
        contentType: type,
        lastModified: new Date(),
        etag: `"${md5(data)}"`,
      });
    },
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  };
}
