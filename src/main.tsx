import React from "react";
import ReactDOM from "react-dom/client";
import App from "./App";
import { installWindowDrag } from "./lib/window";
import "./styles/global.css";

// Every `.drag-handle` area moves its window, whatever sits inside it.
installWindowDrag();

ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);
