import { useRoutes } from "react-router-dom";
import Home from "../views/home/main";
import NotFound from "../views/not-found/main";
import NewRoundPage from "../views/new-round/main";

function Router() {
  const routes = [
    {
      path: "/",
      element: <Home />,
    },
    {
      path: "/new-round",
      element: <NewRoundPage />,
    },
    {
      path: "*",
      element: <NotFound />,
    },
  ];
  return useRoutes(routes);
}

export default Router;
