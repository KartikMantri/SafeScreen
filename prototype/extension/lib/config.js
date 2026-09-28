// SafeScreen configuration for the ISRO workspace deployment.

export const DEFAULTS = {
  gatewayUrl: "http://localhost:8000",
  apiKey: "isro-demo-key",
  maxLoopIterations: 20,           // FR-014-06
  auditLog: true,                  // enterprise-tier DPDP audit log (FR-006-07)
  // The agent only operates inside the ISRO digital workspace. Anything else is refused.
  workspaceOrigins: [
    "http://localhost:8000",       // prototype: mock ISRO Employee Services Portal
    "http://127.0.0.1:8000",
    "https://*.isro.gov.in",
    "https://isro.gov.in",
    "https://*.nrsc.gov.in",       // NRSC / Bhuvan
    "https://*.shar.gov.in",       // SDSC SHAR (Launch View Gallery)
    "https://*.sac.gov.in",
    "https://*.vssc.gov.in",
    "https://*.ursc.gov.in",
    "https://*.iirs.gov.in",
  ],
  // ISRO-specific custom rules (Pro/Enterprise "custom pattern rules")
  customRules: [
    { type: "EMPLOYEE_ID", pattern: "\\bISRO-[A-Z]{2,6}-\\d{4,6}\\b" },
  ],
};

export async function loadConfig() {
  try {
    const stored = await chrome.storage.local.get("config");
    return { ...DEFAULTS, ...(stored.config || {}) };
  } catch {
    return { ...DEFAULTS };
  }
}

export async function saveConfig(cfg) {
  await chrome.storage.local.set({ config: cfg });
}

export function isWorkspaceUrl(url, origins) {
  let u;
  try { u = new URL(url); } catch { return false; }
  return origins.some((pattern) => {
    const m = pattern.match(/^(https?):\/\/(\*\.)?([^/]+)$/);
    if (!m) return false;
    const [, scheme, wildcard, host] = m;
    if (u.protocol !== scheme + ":") return false;
    if (wildcard) return u.host === host || u.host.endsWith("." + host);
    return u.host === host;
  });
}
