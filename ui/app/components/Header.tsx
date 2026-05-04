import React from "react";
import { Link } from "react-router-dom";
import { AppHeader } from "@dynatrace/strato-components-preview/layouts";
import { TimeframeSelector } from "@dynatrace/strato-components/filters";
import { useAppTimeframe } from "../state/TimeframeContext";

export const Header = () => {
  const { timeframe, setTimeframe } = useAppTimeframe();
  return (
    <AppHeader>
      <AppHeader.NavItems>
        <AppHeader.AppNavLink as={Link} to="/" />
        <AppHeader.NavItem as={Link} to="/">
          Services Overview
        </AppHeader.NavItem>
      </AppHeader.NavItems>
      <AppHeader.ActionItems>
        <div style={{ minWidth: 280 }}>
          <TimeframeSelector
            value={
              timeframe.raw ?? { from: timeframe.from, to: timeframe.to }
            }
            onChange={(v) => setTimeframe(v)}
          />
        </div>
      </AppHeader.ActionItems>
    </AppHeader>
  );
};
