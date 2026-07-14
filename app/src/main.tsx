import React from "react";
import ReactDOM from "react-dom/client";
import App from "./App";
// Импорт ради side-effect: применить сохранённую тему к <html data-theme>
// до первого рендера (дублирует инлайн-скрипт в index.html на случай miss).
import "./store/theme";

ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);
