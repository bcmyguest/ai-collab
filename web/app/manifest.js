// Installable web app: iOS Safari delivers Web Push only to a Home Screen app; Android browsers need no install.
export default function manifest() {
  return {
    name: "AI Collab", short_name: "AI Collab", start_url: "/", scope: "/", display: "standalone",
    background_color: "#101117", theme_color: "#101117",
    icons: [{ src: "/icon.svg", sizes: "any", type: "image/svg+xml", purpose: "any" }],
  };
}
