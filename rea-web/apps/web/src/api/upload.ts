import { API_ROUTES } from "@rea-web/contracts/browser";
import type { z } from "zod";
import { API_PREFIX, ApiClientError, errorFromResponse } from "./client";

type Target = z.output<typeof API_ROUTES.uploadTarget.response>;

const isControl = (char: string): boolean => {
  const code = char.codePointAt(0) ?? 0;
  return code <= 0x1f || code === 0x7f;
};

/**
 * `X-Target-Name` carries the name as a header value: it must fit in Latin-1
 * and obey the same limits the API enforces. Returns a problem or null.
 */
export const targetNameProblem = (name: string): string | null => {
  if (name.length === 0) return "A target name is required.";
  if (name.length > 255) return "A target name is at most 255 characters.";
  if (/[\\/]/u.test(name)) return "A target name cannot contain / or \\.";
  if ([...name].some(isControl))
    return "A target name cannot contain control characters.";
  if (name === "." || name === "..") return "That target name is reserved.";
  if (name.trim() !== name)
    return "A target name cannot start or end with spaces.";
  // Header values are ByteStrings: anything above U+00FF cannot be sent.
  if ([...name].some((char) => char.codePointAt(0)! > 0xff))
    return "This name has characters that an HTTP header cannot carry; enter a different target name.";
  return null;
};

export interface UploadProgress {
  readonly loaded: number;
  readonly total: number | null;
}

export interface UploadRequest {
  readonly projectId: string;
  readonly body: Blob;
  readonly name: string;
  readonly onProgress?: (progress: UploadProgress) => void;
  readonly signal?: AbortSignal;
}

/** Raw-body upload with progress (XMLHttpRequest exposes upload progress). */
export const uploadTarget = (request: UploadRequest): Promise<Target> =>
  new Promise((resolve, reject) => {
    const problem = targetNameProblem(request.name);
    if (problem !== null) {
      reject(new ApiClientError("validation_failed", problem));
      return;
    }
    const xhr = new XMLHttpRequest();
    xhr.open(
      "POST",
      `${API_PREFIX}/projects/${encodeURIComponent(request.projectId)}/targets/uploads`,
    );
    xhr.withCredentials = false;
    xhr.setRequestHeader("X-Target-Name", request.name);
    xhr.setRequestHeader("Content-Type", "application/octet-stream");
    xhr.setRequestHeader("Accept", "application/json");
    xhr.upload.onprogress = (event) =>
      request.onProgress?.({
        loaded: event.loaded,
        total: event.lengthComputable ? event.total : null,
      });
    xhr.onerror = () =>
      reject(new ApiClientError("network_error", "The upload failed"));
    xhr.onabort = () =>
      reject(new DOMException("The upload was cancelled", "AbortError"));
    xhr.onload = () => {
      if (xhr.status < 200 || xhr.status >= 300) {
        reject(errorFromResponse(xhr.status, xhr.responseText));
        return;
      }
      try {
        const parsed = API_ROUTES.uploadTarget.response.safeParse(
          JSON.parse(xhr.responseText),
        );
        if (parsed.success) resolve(parsed.data);
        else
          reject(
            new ApiClientError(
              "invalid_response",
              "uploadTarget: the response does not match its contract",
              { status: xhr.status },
            ),
          );
      } catch {
        reject(
          new ApiClientError(
            "invalid_response",
            "uploadTarget: the response is not JSON",
            { status: xhr.status },
          ),
        );
      }
    };
    request.signal?.addEventListener("abort", () => xhr.abort(), {
      once: true,
    });
    xhr.send(request.body);
  });
