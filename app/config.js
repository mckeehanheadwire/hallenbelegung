// Data: read directly from WREN's public API (halls + bookings are public, read-only).
// Requests: sent to the Cloudflare Worker, which holds the WREN key. On
// muri.example-company.xyz that is the same origin; the copy on the WREN tree calls it cross-origin.
window.HALLEN_CONFIG = {
  dataBase: "https://wren.aemwip.com/api/v1/orgs/hallenbelegung-muri-guemligen",
  apiBase: location.hostname === "wren.aemwip.com" ? "https://muri.example-company.xyz/api" : "/api",
};
