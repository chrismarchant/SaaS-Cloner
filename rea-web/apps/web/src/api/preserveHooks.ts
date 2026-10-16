import {
  useInfiniteQuery,
  useMutation,
  useQuery,
  useQueryClient,
} from "@tanstack/react-query";
import { api, isApiClientError, type BodyOf } from "./client";
import { flatten } from "./hooks";
import { parseManifest, type ManifestParse } from "../lib/manifestView";
import { parseRestoreReport, type ReportParse } from "../lib/reportView";

/** Every key sits under `["p", project]`, which a finished job stream invalidates. */
const base = (p: string) => ["p", p, "builds"] as const;
export const preserveKeys = {
  list: (p: string) => [...base(p), "list"] as const,
  build: (p: string, b: string) => [...base(p), b] as const,
  plan: (p: string, b: string, pl: string) =>
    [...base(p), b, "plans", pl] as const,
  capture: (p: string, b: string, c: string) =>
    [...base(p), b, "captures", c] as const,
  manifest: (p: string, b: string, c: string) =>
    [...base(p), b, "captures", c, "manifest"] as const,
  coverage: (p: string, b: string, c: string) =>
    [...base(p), b, "captures", c, "coverage"] as const,
  report: (p: string, b: string, c: string, v: string) =>
    [...base(p), b, "captures", c, "verifications", v, "report"] as const,
  verification: (p: string, b: string, c: string, v: string) =>
    [...base(p), b, "captures", c, "verifications", v] as const,
  export: (p: string, b: string, e: string) =>
    [...base(p), b, "exports", e] as const,
  plans: (p: string, b: string) => [...base(p), b, "plans", "list"] as const,
  captures: (p: string, b: string) =>
    [...base(p), b, "captures", "list"] as const,
  verifications: (p: string, b: string, c: string) =>
    [...base(p), b, "captures", c, "verifications", "list"] as const,
  exports: (p: string, b: string, c: string | null) =>
    [...base(p), b, "exports", "list", c ?? "all"] as const,
};

const PAGE = 100;

export const useBuilds = (p: string) =>
  useInfiniteQuery({
    queryKey: preserveKeys.list(p),
    initialPageParam: undefined as string | undefined,
    queryFn: ({ pageParam, signal }) =>
      api.call(
        "listBuilds",
        {
          params: { p },
          query: { limit: PAGE, ...(pageParam ? { cursor: pageParam } : {}) },
        },
        { signal },
      ),
    getNextPageParam: (last) => last.next_cursor ?? undefined,
  });

export const useBuild = (p: string, b: string | null) =>
  useQuery({
    queryKey: preserveKeys.build(p, b ?? ""),
    enabled: b !== null,
    queryFn: ({ signal }) =>
      api.call("getBuild", { params: { p, b: b ?? "" } }, { signal }),
  });

export const useCreateBuild = (p: string) => {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (body: BodyOf<"createBuild">) =>
      api.call("createBuild", { params: { p }, body }),
    onSuccess: () =>
      client.invalidateQueries({ queryKey: preserveKeys.list(p) }),
  });
};

const running = (status: string | undefined): boolean =>
  status === "pending" || status === "running";

/** Poll while any listed run is still going; the job stream also invalidates the project. */
const POLL_MS = 4000;
const anyRunning = (items: readonly { status: string }[]): boolean =>
  items.some((item) => running(item.status));

// --- plans -------------------------------------------------------------------

/** getPlan answers 409 `plan_not_ready` (with the producing job) until the job has produced it. */
export const planNotReady = (
  error: unknown,
): {
  readonly jobId: string | null;
  readonly jobState: string | null;
} | null => {
  if (!isApiClientError(error) || error.code !== "conflict") return null;
  const details = error.details;
  if (
    typeof details !== "object" ||
    details === null ||
    (details as Record<string, unknown>)["reason"] !== "plan_not_ready"
  )
    return null;
  const record = details as Record<string, unknown>;
  const text = (value: unknown): string | null =>
    typeof value === "string" ? value : null;
  return { jobId: text(record["job_id"]), jobState: text(record["job_state"]) };
};

export const usePlan = (p: string, b: string, pl: string) =>
  useQuery({
    queryKey: preserveKeys.plan(p, b, pl),
    queryFn: ({ signal }) =>
      api.call("getPlan", { params: { p, b, pl } }, { signal }),
    refetchInterval: (query) => {
      const waiting = planNotReady(query.state.error);
      return waiting !== null &&
        (waiting.jobState === null ||
          !["failed", "cancelled"].includes(waiting.jobState))
        ? 2500
        : false;
    },
  });

export const usePlans = (p: string, b: string) =>
  useInfiniteQuery({
    queryKey: preserveKeys.plans(p, b),
    initialPageParam: undefined as string | undefined,
    queryFn: ({ pageParam, signal }) =>
      api.call(
        "listPlans",
        {
          params: { p, b },
          query: { limit: PAGE, ...(pageParam ? { cursor: pageParam } : {}) },
        },
        { signal },
      ),
    getNextPageParam: (last) => last.next_cursor ?? undefined,
    refetchInterval: (query) =>
      anyRunning(flatten(query.state.data)) ? POLL_MS : false,
  });

export const useCreatePlan = (p: string, b: string) => {
  const client = useQueryClient();
  return useMutation({
    mutationFn: () => api.call("createPlan", { params: { p, b }, body: {} }),
    onSuccess: () =>
      client.invalidateQueries({ queryKey: preserveKeys.plans(p, b) }),
  });
};

// --- captures ----------------------------------------------------------------

export const useCapture = (p: string, b: string, c: string) =>
  useQuery({
    queryKey: preserveKeys.capture(p, b, c),
    queryFn: ({ signal }) =>
      api.call("getCapture", { params: { p, b, c } }, { signal }),
    refetchInterval: (query) =>
      running(query.state.data?.status) ? 2500 : false,
  });

export const useCaptures = (p: string, b: string) =>
  useInfiniteQuery({
    queryKey: preserveKeys.captures(p, b),
    initialPageParam: undefined as string | undefined,
    queryFn: ({ pageParam, signal }) =>
      api.call(
        "listCaptures",
        {
          params: { p, b },
          query: { limit: PAGE, ...(pageParam ? { cursor: pageParam } : {}) },
        },
        { signal },
      ),
    getNextPageParam: (last) => last.next_cursor ?? undefined,
    refetchInterval: (query) =>
      anyRunning(flatten(query.state.data)) ? POLL_MS : false,
  });

export const useCreateCapture = (p: string, b: string) => {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (planId: string) =>
      api.call("createCapture", {
        params: { p, b },
        body: { plan_id: planId },
      }),
    onSuccess: (created) => {
      client.setQueryData(preserveKeys.capture(p, b, created.id), created);
      return client.invalidateQueries({
        queryKey: preserveKeys.captures(p, b),
      });
    },
  });
};

/** The manifest, fetched as stored and parsed once with the contract schema. */
export const useManifest = (
  p: string,
  b: string,
  c: string,
  enabled: boolean,
) =>
  useQuery<ManifestParse>({
    queryKey: preserveKeys.manifest(p, b, c),
    enabled,
    staleTime: Infinity,
    gcTime: 5 * 60_000,
    queryFn: async ({ signal }) => {
      const response = await api.stream(
        "getCaptureManifest",
        { params: { p, b, c } },
        { signal },
      );
      let json: unknown;
      try {
        json = JSON.parse(await response.text());
      } catch {
        return { ok: false, issues: ["The manifest is not valid JSON."] };
      }
      return parseManifest(json);
    },
  });

export const useCoverage = (
  p: string,
  b: string,
  c: string,
  enabled: boolean,
) =>
  useQuery({
    queryKey: preserveKeys.coverage(p, b, c),
    enabled,
    queryFn: ({ signal }) =>
      api.call("getCaptureCoverage", { params: { p, b, c } }, { signal }),
  });

// --- verifications -----------------------------------------------------------

export const useVerification = (p: string, b: string, c: string, v: string) =>
  useQuery({
    queryKey: preserveKeys.verification(p, b, c, v),
    queryFn: ({ signal }) =>
      api.call("getVerification", { params: { p, b, c, v } }, { signal }),
    refetchInterval: (query) =>
      running(query.state.data?.status) ? 2500 : false,
  });

export const useVerifications = (p: string, b: string, c: string) =>
  useInfiniteQuery({
    queryKey: preserveKeys.verifications(p, b, c),
    initialPageParam: undefined as string | undefined,
    queryFn: ({ pageParam, signal }) =>
      api.call(
        "listVerifications",
        {
          params: { p, b, c },
          query: { limit: PAGE, ...(pageParam ? { cursor: pageParam } : {}) },
        },
        { signal },
      ),
    getNextPageParam: (last) => last.next_cursor ?? undefined,
    refetchInterval: (query) =>
      anyRunning(flatten(query.state.data)) ? POLL_MS : false,
  });

export const useCreateVerification = (p: string, b: string, c: string) => {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (body: BodyOf<"createVerification">) =>
      api.call("createVerification", { params: { p, b, c }, body }),
    onSuccess: (created) => {
      client.setQueryData(
        preserveKeys.verification(p, b, c, created.id),
        created,
      );
      return client.invalidateQueries({
        queryKey: preserveKeys.verifications(p, b, c),
      });
    },
  });
};

/** The restore report, fetched as stored and parsed once with the contract schema. */
export const useRestoreReport = (
  p: string,
  b: string,
  c: string,
  v: string,
  enabled: boolean,
) =>
  useQuery<ReportParse>({
    queryKey: preserveKeys.report(p, b, c, v),
    enabled,
    staleTime: Infinity,
    gcTime: 5 * 60_000,
    queryFn: async ({ signal }) => {
      const response = await api.stream(
        "downloadVerificationReport",
        { params: { p, b, c, v } },
        { signal },
      );
      let json: unknown;
      try {
        json = JSON.parse(await response.text());
      } catch {
        return { ok: false, issues: ["The report is not valid JSON."] };
      }
      return parseRestoreReport(json);
    },
  });

export const downloadReportUrl = (
  p: string,
  b: string,
  c: string,
  v: string,
): string => api.url("downloadVerificationReport", { params: { p, b, c, v } });

// --- exports -----------------------------------------------------------------

export const useRecoveryExport = (p: string, b: string, e: string) =>
  useQuery({
    queryKey: preserveKeys.export(p, b, e),
    queryFn: ({ signal }) =>
      api.call("getExport", { params: { p, b, e } }, { signal }),
    refetchInterval: (query) =>
      running(query.state.data?.status) ? 2500 : false,
  });

/** Exports of a build, or of one capture when `c` is given. */
export const useRecoveryExports = (p: string, b: string, c: string | null) =>
  useInfiniteQuery({
    queryKey: preserveKeys.exports(p, b, c),
    initialPageParam: undefined as string | undefined,
    queryFn: ({ pageParam, signal }) =>
      api.call(
        "listExports",
        {
          params: { p, b },
          query: {
            limit: PAGE,
            ...(c === null ? {} : { capture_id: c }),
            ...(pageParam ? { cursor: pageParam } : {}),
          },
        },
        { signal },
      ),
    getNextPageParam: (last) => last.next_cursor ?? undefined,
    refetchInterval: (query) =>
      anyRunning(flatten(query.state.data)) ? POLL_MS : false,
  });

export const useCreateRecoveryExport = (p: string, b: string, c: string) => {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (body: BodyOf<"createExport">) =>
      api.call("createExport", { params: { p, b, c }, body }),
    onSuccess: (created) => {
      client.setQueryData(preserveKeys.export(p, b, created.id), created);
      return client.invalidateQueries({
        queryKey: [...base(p), b, "exports", "list"],
      });
    },
  });
};

export const downloadExportUrl = (p: string, b: string, e: string): string =>
  api.url("downloadExport", { params: { p, b, e } });

export const downloadExportSignatureUrl = (
  p: string,
  b: string,
  e: string,
): string => api.url("downloadExportSignature", { params: { p, b, e } });
