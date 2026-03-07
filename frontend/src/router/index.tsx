import { useRoutes } from "react-router-dom";
import HomePage from "../pages/HomePage";
import AppPage from "../pages/AppPage";

function Router() {
  const routes = [
    {
      path: "/",
      element: <HomePage />,
    },
    {
      path: "/app",
      element: <AppPage />,
    },
  ];
  return useRoutes(routes);
}

export default Router;
