import { createRoot } from "react-dom/client";
import { setBaseUrl } from "@workspace/api-client-react";
import App from "./App";
import { apiBaseUrl } from "./lib/api-base";
import "./index.css";

setBaseUrl(apiBaseUrl || null);

createRoot(document.getElementById("root")!).render(<App />);
