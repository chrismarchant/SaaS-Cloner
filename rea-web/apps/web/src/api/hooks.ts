import {
  keepPreviousData,
  useInfiniteQuery,
  useMutation,
  useQuery,
  useQueryClient,
  type InfiniteData,
  type QueryClient,
} from "@tanstack/react-query";
import { TERMINAL_JOB_STATES, type JobState } from "@rea-web/contracts/browser";
import { api, isApiClientError, type BodyOf } from "./client";

export const keys = {
  me: ["me"] as const,
  projects: ["projects"] as const,
  project: (p: string) => ["p", p] as const,
  runners: (p: string) => ["p", p, "runners"] as const,
  capabilities: (p: string, r: string) =>
    ["p", p, "runners", r, "capabilities"] as const,
  tools: (p: string) => ["p", p, "tools"] as const,
  targets: (p: string) => ["p", p, "targets"] as const,
  routing: (p: string, t: string) => ["p", p, "targets", t, "routing"] as const,
  investigations: (p: string) => ["p", p, "investigations"] as const,
  investigation: (p: string, i: string) =>
    ["p", p, "investigation", i] as const,
  calls: (p: string, i: string) =>
    ["p", p, "investigation", i, "calls"] as const,
  raw: (p: string, i: string, c: string) =>
    ["p", p, "investigation", i, "raw", c] as const,
  findings: (p: string, i: string) =>
    ["p", p, "investigation", i, "findings"] as const,
  evidence: (p: string, i: string) =>
    ["p", p, "investigation", i, "evidence"] as const,
  job: (p: string, j: string) => ["p", p, "jobs", j] as const,
  jobs: (p: string, kind: string) => ["p", p, "jobs", "list", kind] as const,
  approvals: (p: string, j: string) =>
    ["p", p, "jobs", j, "approvals"] as const,
};

/** 4xx answers are final; transient failures get two more tries. */
export const shouldRetry = (count: number, error: unknown): boolean =>
  !(isApiClientError(error) && error.status >= 400 && error.status < 500) &&
  count < 2;

export const isTerminal = (state: JobState | null | undefined): boolean =>
  state !== null && state !== undefined && TERMINAL_JOB_STATES.has(state);

interface Page<T> {
  readonly items: T[];
  readonly next_cursor: string | null;
}

export const flatten = <T>(data: InfiniteData<Page<T>> | undefined): T[] =>
  data?.pages.flatMap((page) => page.items) ?? [];

// --- auth ------------------------------------------------------------------

export const useMe = () =>
  useQuery({
    queryKey: keys.me,
    queryFn: ({ signal }) => api.call("me", {}, { signal }),
    staleTime: 60_000,
  });

/** Forget everything fetched under another identity, except `me` itself. */
const dropProjectData = (client: QueryClient): void =>
  client.removeQueries({
    predicate: (query) => query.queryKey[0] !== keys.me[0],
  });

export interface Credentials {
  readonly email: string;
  readonly password: string;
  readonly displayName?: string;
}

export const useSignIn = (mode: "login" | "register") => {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (credentials: Credentials) => {
      const { email, password, displayName } = credentials;
      return mode === "login"
        ? api.call("login", { body: { email, password } })
        : api.call("register", {
            body: {
              email,
              password,
              ...(displayName ? { display_name: displayName } : {}),
            },
          });
    },
    onSuccess: (me) => {
      dropProjectData(client);
      client.setQueryData(keys.me, me);
    },
  });
};

export const useLogout = () => {
  const client = useQueryClient();
  return useMutation({
    mutationFn: () => api.call("logout"),
    // Whatever the answer, nothing of the old session stays on screen.
    onSettled: async () => {
      dropProjectData(client);
      await client.resetQueries({ queryKey: keys.me });
    },
  });
};

export const useProjects = () =>
  useQuery({
    queryKey: keys.projects,
    queryFn: ({ signal }) => api.call("listProjects", {}, { signal }),
  });

export const useCreateProject = () => {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (body: BodyOf<"createProject">) =>
      api.call("createProject", { body }),
    onSuccess: () => client.invalidateQueries({ queryKey: keys.projects }),
  });
};

// --- runners ---------------------------------------------------------------

export const useRunners = (p: string) =>
  useQuery({
    queryKey: keys.runners(p),
    queryFn: ({ signal }) =>
      api.call("listRunners", { params: { p } }, { signal }),
    refetchInterval: 4000,
  });

export const useCreateRunner = (p: string) => {
  const client = useQueryClient();
  return useMutation({
    // The token is shown once by the caller and then dropped from the cache.
    gcTime: 0,
    mutationFn: (body: BodyOf<"createRunner">) =>
      api.call("createRunner", { params: { p }, body }),
    onSuccess: () => client.invalidateQueries({ queryKey: keys.runners(p) }),
  });
};

export const useRevokeRunner = (p: string) => {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (r: string) => api.call("revokeRunner", { params: { p, r } }),
    onSuccess: () => client.invalidateQueries({ queryKey: keys.runners(p) }),
  });
};

export const useCapabilities = (p: string, r: string) =>
  useQuery({
    queryKey: keys.capabilities(p, r),
    queryFn: ({ signal }) =>
      api.call("getRunnerCapabilities", { params: { p, r } }, { signal }),
    refetchInterval: 10_000,
  });

export const useProjectTools = (p: string) =>
  useQuery({
    queryKey: keys.tools(p),
    queryFn: ({ signal }) =>
      api.call("projectTools", { params: { p } }, { signal }),
    staleTime: 15_000,
  });

// --- targets ---------------------------------------------------------------

const PAGE = 100;

export const useTargets = (p: string) =>
  useInfiniteQuery({
    queryKey: keys.targets(p),
    initialPageParam: undefined as string | undefined,
    queryFn: ({ pageParam, signal }) =>
      api.call(
        "listTargets",
        {
          params: { p },
          query: { limit: PAGE, ...(pageParam ? { cursor: pageParam } : {}) },
        },
        { signal },
      ),
    getNextPageParam: (last) => last.next_cursor ?? undefined,
  });

export const useCreateUrlTarget = (p: string) => {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (body: BodyOf<"createUrlTarget">) =>
      api.call("createUrlTarget", { params: { p }, body }),
    onSuccess: () => client.invalidateQueries({ queryKey: keys.targets(p) }),
  });
};

export const useTargetRouting = (p: string, t: string | null) =>
  useQuery({
    queryKey: keys.routing(p, t ?? ""),
    enabled: t !== null,
    queryFn: ({ signal }) =>
      api.call("getTargetRouting", { params: { p, t: t ?? "" } }, { signal }),
    refetchInterval: 15_000,
  });

// --- investigations --------------------------------------------------------

export const useInvestigations = (p: string) =>
  useInfiniteQuery({
    queryKey: keys.investigations(p),
    initialPageParam: undefined as string | undefined,
    queryFn: ({ pageParam, signal }) =>
      api.call(
        "listInvestigations",
        {
          params: { p },
          query: { limit: PAGE, ...(pageParam ? { cursor: pageParam } : {}) },
        },
        { signal },
      ),
    getNextPageParam: (last) => last.next_cursor ?? undefined,
    refetchInterval: 5000,
  });

export const useCreateInvestigation = (p: string) => {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (body: BodyOf<"createInvestigation">) =>
      api.call("createInvestigation", { params: { p }, body }),
    onSuccess: () =>
      client.invalidateQueries({ queryKey: keys.investigations(p) }),
  });
};

export const useInvestigation = (p: string, i: string) =>
  useQuery({
    queryKey: keys.investigation(p, i),
    queryFn: ({ signal }) =>
      api.call("getInvestigation", { params: { p, i } }, { signal }),
    refetchInterval: (query) => {
      const status = query.state.data?.status;
      return status === "pending" || status === "running" ? 2000 : false;
    },
  });

export const useToolCalls = (p: string, i: string, live: boolean) =>
  useInfiniteQuery({
    queryKey: keys.calls(p, i),
    initialPageParam: undefined as string | undefined,
    queryFn: ({ pageParam, signal }) =>
      api.call(
        "listToolCalls",
        {
          params: { p, i },
          query: { limit: 200, ...(pageParam ? { cursor: pageParam } : {}) },
        },
        { signal },
      ),
    getNextPageParam: (last) => last.next_cursor ?? undefined,
    refetchInterval: live ? 3000 : false,
    placeholderData: keepPreviousData,
  });

export const useFindings = (p: string, i: string, live: boolean) =>
  useQuery({
    queryKey: keys.findings(p, i),
    queryFn: ({ signal }) =>
      api.call("listFindings", { params: { p, i } }, { signal }),
    refetchInterval: live ? 3000 : false,
  });

export const useEvidence = (p: string, i: string, live: boolean) =>
  useQuery({
    queryKey: keys.evidence(p, i),
    queryFn: ({ signal }) =>
      api.call("listEvidence", { params: { p, i } }, { signal }),
    refetchInterval: live ? 3000 : false,
  });

/** The stored raw upstream result, parsed. Only fetched when `enabled`. */
export const useRawResult = (
  p: string,
  i: string,
  c: string,
  enabled: boolean,
) =>
  useQuery({
    queryKey: keys.raw(p, i, c),
    enabled,
    staleTime: Infinity,
    gcTime: 60_000,
    queryFn: async ({ signal }) => {
      const response = await api.stream(
        "getToolCallRaw",
        { params: { p, i, c } },
        { signal },
      );
      return JSON.parse(await response.text()) as unknown;
    },
  });

// --- jobs ------------------------------------------------------------------

export const useJob = (p: string, j: string | null) =>
  useQuery({
    queryKey: keys.job(p, j ?? ""),
    enabled: j !== null,
    queryFn: ({ signal }) =>
      api.call("getJob", { params: { p, j: j ?? "" } }, { signal }),
    refetchInterval: (query) =>
      isTerminal(query.state.data?.state) ? false : 3000,
  });

export const useJobsOfKind = (p: string, kind: string, live: boolean) =>
  useQuery({
    queryKey: keys.jobs(p, kind),
    queryFn: ({ signal }) =>
      api.call(
        "listJobs",
        { params: { p }, query: { kind, limit: 200 } },
        { signal },
      ),
    refetchInterval: live ? 4000 : false,
  });

export const useApprovals = (p: string, j: string, enabled: boolean) =>
  useQuery({
    queryKey: keys.approvals(p, j),
    enabled,
    queryFn: ({ signal }) =>
      api.call("listApprovals", { params: { p, j } }, { signal }),
    refetchInterval: enabled ? 2000 : false,
  });

export const useJobAction = (p: string, j: string) => {
  const client = useQueryClient();
  const refresh = () => client.invalidateQueries({ queryKey: keys.project(p) });
  return {
    cancel: useMutation({
      mutationFn: () => api.call("cancelJob", { params: { p, j } }),
      onSuccess: refresh,
    }),
    approve: useMutation({
      mutationFn: (approval_id: string) =>
        api.call("approveJob", { params: { p, j }, body: { approval_id } }),
      onSuccess: refresh,
    }),
    reject: useMutation({
      mutationFn: (approval_id: string) =>
        api.call("rejectJob", { params: { p, j }, body: { approval_id } }),
      onSuccess: refresh,
    }),
  };
};

export const useFollowUp = (p: string, i: string) => {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (body: BodyOf<"createFollowUp">) =>
      api.call("createFollowUp", { params: { p, i }, body }),
    onSuccess: () =>
      client.invalidateQueries({
        queryKey: keys.jobs(p, "investigation.follow_up"),
      }),
  });
};

export const useCreateExport = (p: string, i: string) => {
  const client = useQueryClient();
  return useMutation({
    mutationFn: () =>
      api.call("createInvestigationExport", { params: { p, i } }),
    onSuccess: () =>
      client.invalidateQueries({
        queryKey: keys.jobs(p, "investigation.export"),
      }),
  });
};

export const useCreateComparison = (p: string) => {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (body: BodyOf<"createComparison">) =>
      api.call("createComparison", { params: { p }, body }),
    onSuccess: () =>
      client.invalidateQueries({
        queryKey: keys.jobs(p, "investigation.compare"),
      }),
  });
};
