import "./styles.css";

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { Tooltip } from "radix-ui";
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";

import { App } from "./app";
import { connect } from "./lib/live";

const client = new QueryClient({
  defaultOptions: { queries: { staleTime: 15_000, refetchOnWindowFocus: false, retry: 1 } },
});
connect(client);

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <QueryClientProvider client={client}>
      <Tooltip.Provider delayDuration={400} skipDelayDuration={300}>
        <App />
      </Tooltip.Provider>
    </QueryClientProvider>
  </StrictMode>,
);
