# DISCLAIMER
This project was created by myself, an SE of Dynatrace. This is not an official Dynatrace application and it is not something you can open a support ticket on. You may create an issue on the github repository, however there is no guaruntee it will be addressed (this isn't my primary job, just a fun project). Feel free to fork the repository (https://github.com/TechShady/user-journey-app) for your own use as well.

The Services Overview App is a Dynatrace platform application that provides a comprehensive, multi-tab SRE command center for monitoring, analyzing, and managing service reliability across an entire fleet. It aggregates RED metrics (Rate, Errors, Duration), Kubernetes workload health, dependency topology, SLO error budgets, anomaly detection, blast radius simulation, and capacity planning into a single unified interface.

## Getting Started

### Prerequisites

- Node.js 22.x (recommended: latest 22 LTS)
- A Dynatrace environment with RUM enabled
- `dt-app` CLI (`npx dt-app`)

Use `.nvmrc` to match the project runtime:

```bash
nvm use
```

### Pre-Install

- Fork the repo
- Modify app.config.json and update environmentUrl with your Dynatrace tenant URL

### Install

```bash
npm install
```

### Development

```bash
npx dt-app dev
```

### Deploy

```bash
npx dt-app deploy
```

## Configuration

All tabs support user-configurable visibility and ordering (persisted per user).

## Tech Stack

- **Platform:** Dynatrace App Toolkit (dt-app)
- **UI:** React 18 + Strato Design System
- **Data:** DQL via `@dynatrace-sdk/client-query`
- **Visualizations:** D3-geo, TopoJSON, custom SVG

## License

ISC
