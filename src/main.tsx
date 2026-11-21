import { createRoot } from "react-dom/client";
import { lazy, Suspense } from "react";
import "./styles.css";
import { Busy } from "./components";
const Home = lazy(() => import("./Home"));
const Files = lazy(() => import("./Files"));
const Session = lazy(() => import("./Session"));
const Benchmark = lazy(() => import("./Benchmark"));
function Host() {
  import("./media/engine").then(({ ChromiumMediaEngine }) => {
    (window as any).__nearlinkHost ??= new ChromiumMediaEngine();
  });
  return null;
}
const kind = window.nearlink.windowKind;
createRoot(document.getElementById("root")!).render(
  <Suspense fallback={<Busy />}>
    {kind === "host" ? (
      <Host />
    ) : kind === "remote" ? (
      <Session />
    ) : kind === "files" ? (
      <Files />
    ) : kind === "benchmark" ? (
      <Benchmark />
    ) : (
      <Home />
    )}
  </Suspense>,
);
