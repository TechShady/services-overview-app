import { Page } from "@dynatrace/strato-components-preview/layouts";
import React from "react";
import { Route, Routes } from "react-router-dom";
import { DisclaimerModal } from "./components/DisclaimerModal";
import { ServicesOverview } from "./pages/ServicesOverview";
import { TimeframeProvider } from "./state/TimeframeContext";

class ErrorBoundary extends React.Component<{ children: React.ReactNode }, { hasError: boolean }> {
  state = { hasError: false };
  static getDerivedStateFromError() { return { hasError: true }; }
  componentDidCatch(error: any, info: any) {
    const msg = error?.message || error?.toString?.() || "";
    // Auto-recover from QUERY_GONE errors (stale DQL tokens when tab was backgrounded)
    if (msg.includes("QUERY_GONE") || msg.includes("query ID is not available") || msg.includes("410") || error?.status === 410) {
      setTimeout(() => this.setState({ hasError: false }), 100);
      return;
    }
    console.error("[ErrorBoundary]", error, info);
  }
  render() {
    if (this.state.hasError) {
      // Auto-reload after brief delay to handle query token expiry
      setTimeout(() => window.location.reload(), 1500);
      return (
        <div style={{ padding: 40, textAlign: "center" }}>
          <h2>Refreshing...</h2>
          <p>Reconnecting to data source. Please wait.</p>
        </div>
      );
    }
    return this.props.children;
  }
}

export const App = () => {
  return (
    <ErrorBoundary>
      <TimeframeProvider>
        <DisclaimerModal />
        <Page>
          <Page.Main>
            <Routes>
              <Route path="/" element={<ServicesOverview />} />
            </Routes>
          </Page.Main>
        </Page>
      </TimeframeProvider>
    </ErrorBoundary>
  );
};
