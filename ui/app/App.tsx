import { Page } from "@dynatrace/strato-components-preview/layouts";
import React from "react";
import { Route, Routes } from "react-router-dom";
import { Header } from "./components/Header";
import { ServicesOverview } from "./pages/ServicesOverview";
import { TimeframeProvider } from "./state/TimeframeContext";

export const App = () => {
  return (
    <TimeframeProvider>
      <Page>
        <Page.Header>
          <Header />
        </Page.Header>
        <Page.Main>
          <Routes>
            <Route path="/" element={<ServicesOverview />} />
          </Routes>
        </Page.Main>
      </Page>
    </TimeframeProvider>
  );
};
