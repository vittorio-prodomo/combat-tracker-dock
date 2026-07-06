// Dev-only cache-busting loader for this symlinked dev fork: import the real
// bundle with a per-load query so the browser can never serve stale JS.
// (Top-level await keeps Foundry's esmodule load ordering intact.)
await import(`./index.js?t=${Date.now()}`);
