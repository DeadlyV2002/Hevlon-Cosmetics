import React from "react";
import { createRoot } from "react-dom/client";
import App from "./App";
import "./styles.css";
import { excelDates } from "./lib/dates";

excelDates();

createRoot(document.getElementById("root")!).render(
  <React.StrictMode><App /></React.StrictMode>
);
