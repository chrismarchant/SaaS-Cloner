import { Navigate, Route, Routes } from "react-router-dom";
import { useMe } from "./api/hooks";
import { isApiClientError } from "./api/client";
import { ProjectProvider } from "./api/project";
import { ErrorNotice } from "./components/ErrorNotice";
import { Layout } from "./components/Layout";
import { AuthPage } from "./routes/AuthPage";
import { CapabilitiesPage } from "./routes/CapabilitiesPage";
import { ComparePage } from "./routes/ComparePage";
import { InvestigationDetail } from "./routes/InvestigationDetail";
import { InvestigationsPage } from "./routes/InvestigationsPage";
import { NewInvestigationPage } from "./routes/NewInvestigationPage";
import { RunnersPage } from "./routes/RunnersPage";
import { TargetsPage } from "./routes/TargetsPage";
import { BuildDetail } from "./routes/preserve/BuildDetail";
import { BuildsPage } from "./routes/preserve/BuildsPage";
import { CapturePage } from "./routes/preserve/CapturePage";
import { ExportNewPage, ExportPage } from "./routes/preserve/ExportPages";
import { NewBuildPage } from "./routes/preserve/NewBuildPage";
import { PlanPage } from "./routes/preserve/PlanPage";
import { VerificationPage, VerifyNewPage } from "./routes/preserve/VerifyPages";

export function App() {
  const me = useMe();
  if (me.isPending)
    return (
      <main className="page">
        <p role="status">Loading…</p>
      </main>
    );
  if (me.isError) {
    if (isApiClientError(me.error) && me.error.code === "unauthorized")
      return <AuthPage />;
    return (
      <main className="page">
        <ErrorNotice error={me.error} />
        <button type="button" onClick={() => void me.refetch()}>
          Retry
        </button>
      </main>
    );
  }
  return (
    <ProjectProvider>
      <Routes>
        <Route element={<Layout />}>
          <Route index element={<Navigate to="/investigations" replace />} />
          <Route path="investigations" element={<InvestigationsPage />} />
          <Route path="investigations/new" element={<NewInvestigationPage />} />
          <Route path="investigations/:id" element={<InvestigationDetail />} />
          <Route path="targets" element={<TargetsPage />} />
          <Route path="runners" element={<RunnersPage />} />
          <Route path="runners/:id" element={<CapabilitiesPage />} />
          <Route path="compare" element={<ComparePage />} />
          <Route path="preserve" element={<BuildsPage />} />
          <Route path="preserve/new" element={<NewBuildPage />} />
          <Route path="preserve/builds/:b" element={<BuildDetail />} />
          <Route path="preserve/builds/:b/plans/:pl" element={<PlanPage />} />
          <Route
            path="preserve/builds/:b/captures/:c"
            element={<CapturePage />}
          />
          <Route
            path="preserve/builds/:b/captures/:c/verify"
            element={<VerifyNewPage />}
          />
          <Route
            path="preserve/builds/:b/captures/:c/verifications/:v"
            element={<VerificationPage />}
          />
          <Route
            path="preserve/builds/:b/captures/:c/export"
            element={<ExportNewPage />}
          />
          <Route
            path="preserve/builds/:b/exports/:e"
            element={<ExportPage />}
          />
          <Route path="*" element={<NotFound />} />
        </Route>
      </Routes>
    </ProjectProvider>
  );
}

function NotFound() {
  return (
    <>
      <h1>Page not found</h1>
      <p>This address does not match a screen.</p>
    </>
  );
}
