import { createHash, randomUUID } from "node:crypto";
import {
  createServer,
  type IncomingMessage,
  type ServerResponse,
} from "node:http";
import type { AddressInfo } from "node:net";

export interface MockObject {
  body: Buffer;
  metadata: Record<string, string>;
  contentType: string;
  lastModified: Date;
  etag: string;
}

interface MockUpload {
  key: string;
  metadata: Record<string, string>;
  contentType: string;
  parts: Map<number, Buffer>;
}

export interface MockS3 {
  readonly endpoint: string;
  readonly bucket: string;
  readonly objects: Map<string, MockObject>;
  readonly uploads: Map<string, MockUpload>;
  /** `METHOD /path?query` for every request, in arrival order. */
  readonly requests: string[];
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

const readBody = async (req: IncomingMessage): Promise<Buffer> => {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks);
};

const metadataOf = (req: IncomingMessage): Record<string, string> => {
  const metadata: Record<string, string> = {};
  for (const [name, value] of Object.entries(req.headers)) {
    if (name.startsWith("x-amz-meta-") && typeof value === "string")
      metadata[name.slice("x-amz-meta-".length)] = value;
  }
  return metadata;
};

const sendXml = (res: ServerResponse, status: number, xml: string): void => {
  res.writeHead(status, { "content-type": "application/xml" });
  res.end(`<?xml version="1.0" encoding="UTF-8"?>${xml}`);
};

const sendError = (
  res: ServerResponse,
  status: number,
  code: string,
  method: string,
): void => {
  if (method === "HEAD") {
    res.writeHead(status);
    res.end();
    return;
  }
  sendXml(
    res,
    status,
    `<Error><Code>${code}</Code><Message>${code}</Message></Error>`,
  );
};

const objectHeaders = (object: MockObject): Record<string, string> => ({
  "content-length": String(object.body.byteLength),
  "content-type": object.contentType,
  "last-modified": object.lastModified.toUTCString(),
  etag: object.etag,
  ...Object.fromEntries(
    Object.entries(object.metadata).map(([k, v]) => [`x-amz-meta-${k}`, v]),
  ),
});

/**
 * Minimal in-process S3 (path-style, single bucket): PutObject, CopyObject,
 * multipart upload, GetObject, HeadObject, DeleteObject and ListObjectsV2.
 */
export async function startMockS3(bucket: string): Promise<MockS3> {
  const objects = new Map<string, MockObject>();
  const uploads = new Map<string, MockUpload>();
  const requests: string[] = [];

  const store = (
    key: string,
    body: Buffer,
    metadata: Record<string, string>,
    contentType: string,
    etag = `"${md5(body)}"`,
  ): MockObject => {
    const object = {
      body,
      metadata,
      contentType,
      lastModified: new Date(),
      etag,
    };
    objects.set(key, object);
    return object;
  };

  const list = (url: URL, res: ServerResponse): void => {
    const prefix = url.searchParams.get("prefix") ?? "";
    const maxKeys = Number(url.searchParams.get("max-keys") ?? "1000");
    const token = url.searchParams.get("continuation-token");
    const after =
      token === null ? "" : Buffer.from(token, "base64url").toString("utf8");
    const matching = [...objects.keys()]
      .filter((key) => key.startsWith(prefix) && (token === null || key > after))
      .sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
    const page = matching.slice(0, maxKeys);
    const truncated = matching.length > page.length;
    const last = page[page.length - 1];
    const contents = page
      .map((key) => {
        const object = objects.get(key);
        return (
          `<Contents><Key>${escapeXml(key)}</Key>` +
          `<LastModified>${object?.lastModified.toISOString() ?? ""}</LastModified>` +
          `<ETag>${escapeXml(object?.etag ?? "")}</ETag>` +
          `<Size>${object?.body.byteLength ?? 0}</Size>` +
          "<StorageClass>STANDARD</StorageClass></Contents>"
        );
      })
      .join("");
    sendXml(
      res,
      200,
      `<ListBucketResult><Name>${bucket}</Name><Prefix>${escapeXml(prefix)}</Prefix>` +
        `<KeyCount>${page.length}</KeyCount><MaxKeys>${maxKeys}</MaxKeys>` +
        `<IsTruncated>${truncated}</IsTruncated>` +
        (truncated && last !== undefined
          ? `<NextContinuationToken>${Buffer.from(last).toString("base64url")}</NextContinuationToken>`
          : "") +
        `${contents}</ListBucketResult>`,
    );
  };

  const handle = async (
    req: IncomingMessage,
    res: ServerResponse,
  ): Promise<void> => {
    const method = req.method ?? "GET";
    const url = new URL(req.url ?? "/", "http://mock.invalid");
    url.searchParams.delete("x-id");
    requests.push(`${method} ${url.pathname}${url.search}`);
    const bucketPath = `/${bucket}`;
    if (url.pathname !== bucketPath && !url.pathname.startsWith(`${bucketPath}/`))
      return sendError(res, 404, "NoSuchBucket", method);
    const key = decodeURIComponent(url.pathname.slice(bucketPath.length + 1));
    const query = url.searchParams;

    if (key === "") {
      if (method === "GET" && query.get("list-type") === "2")
        return list(url, res);
      return sendError(res, 501, "NotImplemented", method);
    }

    if (method === "POST" && query.has("uploads")) {
      await readBody(req);
      const uploadId = randomUUID();
      uploads.set(uploadId, {
        key,
        metadata: metadataOf(req),
        contentType: req.headers["content-type"] ?? "binary/octet-stream",
        parts: new Map(),
      });
      return sendXml(
        res,
        200,
        `<InitiateMultipartUploadResult><Bucket>${bucket}</Bucket>` +
          `<Key>${escapeXml(key)}</Key><UploadId>${uploadId}</UploadId></InitiateMultipartUploadResult>`,
      );
    }

    if (method === "PUT" && query.has("uploadId") && query.has("partNumber")) {
      const upload = uploads.get(query.get("uploadId") ?? "");
      const body = await readBody(req);
      if (upload === undefined) return sendError(res, 404, "NoSuchUpload", method);
      upload.parts.set(Number(query.get("partNumber")), body);
      res.writeHead(200, { etag: `"${md5(body)}"` });
      return void res.end();
    }

    if (method === "POST" && query.has("uploadId")) {
      await readBody(req);
      const uploadId = query.get("uploadId") ?? "";
      const upload = uploads.get(uploadId);
      if (upload === undefined) return sendError(res, 404, "NoSuchUpload", method);
      const ordered = [...upload.parts.entries()].sort(([a], [b]) => a - b);
      const body = Buffer.concat(ordered.map(([, part]) => part));
      const object = store(
        upload.key,
        body,
        upload.metadata,
        upload.contentType,
        `"${md5(body)}-${ordered.length}"`,
      );
      uploads.delete(uploadId);
      return sendXml(
        res,
        200,
        `<CompleteMultipartUploadResult><Bucket>${bucket}</Bucket>` +
          `<Key>${escapeXml(key)}</Key><ETag>${escapeXml(object.etag)}</ETag></CompleteMultipartUploadResult>`,
      );
    }

    if (method === "DELETE" && query.has("uploadId")) {
      uploads.delete(query.get("uploadId") ?? "");
      res.writeHead(204);
      return void res.end();
    }

    if (method === "PUT") {
      const body = await readBody(req);
      const copySource = req.headers["x-amz-copy-source"];
      if (typeof copySource === "string") {
        const source = decodeURIComponent(copySource).replace(/^\//u, "");
        const original = objects.get(source.slice(bucket.length + 1));
        if (original === undefined)
          return sendError(res, 404, "NoSuchKey", method);
        const ifMatch = req.headers["x-amz-copy-source-if-match"];
        if (typeof ifMatch === "string" && ifMatch !== original.etag)
          return sendError(res, 412, "PreconditionFailed", method);
        const replace = req.headers["x-amz-metadata-directive"] === "REPLACE";
        const copy = store(
          key,
          original.body,
          replace ? metadataOf(req) : original.metadata,
          replace
            ? (req.headers["content-type"] ?? "binary/octet-stream")
            : original.contentType,
          original.etag,
        );
        return sendXml(
          res,
          200,
          `<CopyObjectResult><ETag>${escapeXml(copy.etag)}</ETag></CopyObjectResult>`,
        );
      }
      const object = store(
        key,
        body,
        metadataOf(req),
        req.headers["content-type"] ?? "binary/octet-stream",
      );
      res.writeHead(200, { etag: object.etag });
      return void res.end();
    }

    if (method === "GET" || method === "HEAD") {
      const object = objects.get(key);
      if (object === undefined) return sendError(res, 404, "NoSuchKey", method);
      res.writeHead(200, objectHeaders(object));
      return void res.end(method === "GET" ? object.body : undefined);
    }

    if (method === "DELETE") {
      objects.delete(key);
      res.writeHead(204);
      return void res.end();
    }

    return sendError(res, 501, "NotImplemented", method);
  };

  const server = createServer((req, res) => {
    handle(req, res).catch(() => {
      if (!res.headersSent) res.writeHead(500);
      res.end();
    });
  });
  await new Promise<void>((resolve) => {
    server.listen(0, "127.0.0.1", resolve);
  });
  const { port } = server.address() as AddressInfo;
  return {
    endpoint: `http://127.0.0.1:${port}`,
    bucket,
    objects,
    uploads,
    requests,
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  };
}
