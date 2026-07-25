const routes = {
  home: {
    path: "/",
    title: "Conviction — Bounded prediction-market execution",
    description: "Open, close, or manage buyer-held Polymarket positions with explicit bounds, separate consent, and issuer-signed Polygon proof.",
  },
  trade: {
    path: "/trade",
    title: "Trade — Conviction",
    description: "Preview a live Polymarket market, set an all-in risk budget and hard price cap, then create one wallet-bound OPEN card.",
  },
  manage: {
    path: "/manage",
    title: "Position Manager — Conviction",
    description: "Close an exact buyer-held position or arm one source-bound take-profit order with explicit execution limits.",
  },
  proofs: {
    path: "/proofs",
    title: "Proofs — Conviction",
    description: "Inspect issuer-signed Conviction proofs and independently recompute a Polygon fill against its original economic bounds.",
  },
  wallet: {
    path: "/wallet",
    title: "Buyer Wallet Readiness — Conviction",
    description: "Prepare a dedicated buyer wallet, surface venue setup requirements, and identify funding or policy blockers before payment.",
  },
  security: {
    path: "/security",
    title: "Security Model — Conviction",
    description: "See how Conviction separates payment from trade consent, keeps keys buyer-side, and fails closed on substituted evidence.",
  },
  developers: {
    path: "/developers",
    title: "Developers — Conviction",
    description: "Integrate Conviction's paid OPEN and Position Manager services plus issuer-signed Polygon receipt verification.",
  },
};

const routeAliases = new Map([
  ["/", "home"],
  ["/index.html", "home"],
  ...Object.entries(routes).map(([name, route]) => [route.path, name]),
]);

const navToggle = document.querySelector("#nav-toggle");
const navigation = document.querySelector("#primary-navigation");
const metaDescription = document.querySelector('meta[name="description"]');
const canonical = document.querySelector('link[rel="canonical"]');
const ogUrl = document.querySelector('meta[property="og:url"]');

document.documentElement.classList.add("js");

function routeFromPath(pathname) {
  const normalized = pathname.length > 1 ? pathname.replace(/\/+$/, "") : pathname;
  return routeAliases.get(normalized) || "home";
}

function setMenu(open) {
  navToggle.setAttribute("aria-expanded", String(open));
  navigation.classList.toggle("is-open", open);
  document.body.classList.toggle("menu-open", open);
}

function activateRoute(routeName, { scroll = true } = {}) {
  const name = routes[routeName] ? routeName : "home";
  const route = routes[name];
  document.body.dataset.route = name;
  document.title = route.title;
  metaDescription?.setAttribute("content", route.description);
  canonical?.setAttribute("href", new URL(route.path, window.location.origin).href);
  ogUrl?.setAttribute("content", new URL(route.path, window.location.origin).href);

  for (const view of document.querySelectorAll("[data-route-view]")) {
    const active = view.dataset.routeView === name;
    view.classList.toggle("is-active", active);
    view.hidden = !active;
  }

  for (const link of document.querySelectorAll("[data-route-to]")) {
    const active = link.dataset.routeTo === name;
    if (active) link.setAttribute("aria-current", "page");
    else link.removeAttribute("aria-current");
  }

  setMenu(false);
  if (scroll) window.scrollTo({ top: 0, behavior: "auto" });
}

for (const link of document.querySelectorAll("a[data-route-to]")) {
  link.addEventListener("click", (event) => {
    if (event.defaultPrevented || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
    const name = link.dataset.routeTo;
    const route = routes[name];
    if (!route) return;
    event.preventDefault();
    history.pushState({ route: name }, "", route.path);
    activateRoute(name);
    document.querySelector("#main")?.focus({ preventScroll: true });
  });
}

navToggle.addEventListener("click", () => {
  setMenu(navToggle.getAttribute("aria-expanded") !== "true");
});

document.addEventListener("keydown", (event) => {
  if (event.key === "Escape" && navToggle.getAttribute("aria-expanded") === "true") {
    setMenu(false);
    navToggle.focus();
  }
});

window.addEventListener("popstate", () => activateRoute(routeFromPath(window.location.pathname)));
activateRoute(routeFromPath(window.location.pathname), { scroll: false });
