import { useRoutes } from "react-router-dom";
import Home from "../views/home/main";

function Router() {
  const routes = [
    {
      path: "/",
      element: <Home />,
    },
  ];
  return useRoutes(routes);
}

export default Router;
