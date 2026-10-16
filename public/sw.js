// Service worker minimo: serve per rendere l'app installabile (e quindi
// comparire nel menu "Condividi" di Android). Le richieste vanno sempre in rete.
self.addEventListener("install", () => self.skipWaiting());
self.addEventListener("activate", (e) => e.waitUntil(self.clients.claim()));
self.addEventListener("fetch", () => {});
