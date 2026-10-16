import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import App from "./App";
import "./styles/app.css";

const root = document.getElementById("root");
if (!root) throw new Error("#root 요소가 없습니다");

createRoot(root).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
