export const DEFAULT_BACKEND_ORIGIN = "https://dosebuddy.dosebuddy-health.workers.dev";
export const DEFAULT_API_BASE = `${DEFAULT_BACKEND_ORIGIN}/api`;

/**
 * Resolve the API base URL from the runtime app config.
 * Precedence: explicit apiBase > apiBaseUrl + "/api" > verified backend Worker.
 * Ensures the frontend targets the backend Cloudflare Worker (dosebuddy) rather
 * than sending requests to the static-assets-only frontend Worker (dosebuddy-frontend).
 * @param {{ apiBase?: string; apiBaseUrl?: string } | undefined} appConfig
 * @returns {string}
 */
export function resolveApiBase(appConfig) {
    if (appConfig && typeof appConfig.apiBase === "string" && appConfig.apiBase.trim()) {
        const trimmed = appConfig.apiBase.trim().replace(/\/+$/, "");
        if (trimmed) return trimmed;
    }
    if (appConfig && typeof appConfig.apiBaseUrl === "string" && appConfig.apiBaseUrl.trim()) {
        const trimmed = appConfig.apiBaseUrl.trim().replace(/\/+$/, "");
        if (trimmed) return `${trimmed}/api`;
    }
    return DEFAULT_API_BASE;
}
