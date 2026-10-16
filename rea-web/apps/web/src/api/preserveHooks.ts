import {
  useInfiniteQuery,
  useMutation,
  useQuery,
  useQueryClient,
} from "@tanstack/react-query";
import type { Job } from "@rea-web/contracts/browser";
import { api, isApiClientError, type BodyOf } from "./client";
import { keys, useJobsOfKind } from "./hooks";
import { jobsWhere } from "../lib/buildJobs";
import { parseManifest, type ManifestParse } from "../lib/manifestView";

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
  verification: (p: string, b: string, c: string, v: string) =>
    [...base(p), b, "captures", c, "verifications", v] as const,
  export: (p: string, b: string, e: string) =>
    [...base(p), b, "exports", e] as const,
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

/** Earlier jobs of one kind for one resource, found through the job input. */
export const useBuildJobs = (
  p: string,
  kind: string,
  field: string,
  value: string,
  live: boolean,
): { jobs: Job[]; error: unknown; pending: boolean } => {
  const list = useJobsOfKind(p, kind, live);
  return {
    jobs: jobsWhere(list.data?.items ?? [], field, value),
    error: list.error,
    pending: list.isPending,
  };
};

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

export const useCreatePlan = (p: string, b: string) => {
  const client = useQueryClient();
  return useMutation({
    mutationFn: () => api.call("createPlan", { params: { p, b }, body: {} }),
    onSuccess: () =>
      client.invalidateQueries({ queryKey: keys.jobs(p, "preservation.plan") }),
  });
};

// --- captures ----------------------------------------------------------------

const running = (status: string | undefined): boolean =>
  status === "pending" || status === "running";

export const useCapture = (p: string, b: string, c: string) =>
  useQuery({
    queryKey: preserveKeys.capture(p, b, c),
    queryFn: ({ signal }) =>
      api.call("getCapture", { params: { p, b, c } }, { signal }),
    refetchInterval: (query) =>
      running(query.state.data?.status) ? 2500 : false,
  });

export const useCreateCapture = (p: string, b: string) => {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (planId: string) =>
      api.call("createCapture", {
        params: { p, b },
        body: { plan_id: planId },
      }),
    onSuccess: () =>
      client.invalidateQueries({
        queryKey: keys.jobs(p, "preservation.capture"),
      }),
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

export const useVerification = (p: string, b: string, c: string, v: string) => {
  const client = useQueryClient();
  return useQuery({
    queryKey: preserveKeys.verification(p, b, c, v),
    queryFn: ({ signal }) =>
      api.call("getVerification", { params: { p, b, c, v } }, { signal }),
    // A verification has no status of its own: it is filled when its job
    // succeeds. Stop waiting once the job has failed or been cancelled.
    refetchInterval: (query) => {
      const data = query.state.data;
      if (data === undefined || data.overall !== null) return false;
      const state = client.getQueryData<Job>(keys.job(p, data.job_id))?.state;
      return state === "failed" || state === "cancelled" ? false : 2500;
    },
  });
};

export const useCreateVerification = (p: string, b: string, c: string) => {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (body: BodyOf<"createVerification">) =>
      api.call("createVerification", { params: { p, b, c }, body }),
    onSuccess: () =>
      client.invalidateQueries({ queryKey: keys.jobs(p, "recovery.verify") }),
  });
};

// --- exports -----------------------------------------------------------------

export const useRecoveryExport = (p: string, b: string, e: string) =>
  useQuery({
    queryKey: preserveKeys.export(p, b, e),
    queryFn: ({ signal }) =>
      api.call("getExport", { params: { p, b, e } }, { signal }),
    refetchInterval: (query) =>
      running(query.state.data?.status) ? 2500 : false,
  });

export const useCreateRecoveryExport = (p: string, b: string, c: string) => {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (body: BodyOf<"createExport">) =>
      api.call("createExport", { params: { p, b, c }, body }),
    onSuccess: () =>
      client.invalidateQueries({ queryKey: keys.jobs(p, "recovery.export") }),
  });
};

export const downloadExportUrl = (p: string, b: string, e: string): string =>
  api.url("downloadExport", { params: { p, b, e } });
