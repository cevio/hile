import { jsx as _jsx, jsxs as _jsxs } from "react/jsx-runtime";
import CapabilityPanel from './capability-panel';
function first(value, fallback) {
    return Array.isArray(value) ? value[0] ?? fallback : value ?? fallback;
}
export async function CapabilitiesPage({ searchParams, rsc }) {
    await Promise.resolve();
    const queryLabel = first(searchParams.label, 'default-label');
    const count = Number(first(searchParams.count, '2'));
    return (_jsxs("article", { className: "capability-shell", "data-testid": "plugin-capabilities", "data-build": "v1", children: [_jsx("p", { className: "capability-kicker", children: "REMOTE REACT SERVER COMPONENT \u00B7 BASELINE BUILD" }), _jsx("h1", { children: "Capabilities plugin \u00B7 build v1" }), _jsx("p", { children: "This server-rendered frame carries request data into a nested Ant Design client workspace." }), _jsxs("p", { "data-testid": "server-query", children: [_jsx("strong", { children: "Server received label:" }), " ", queryLabel] }), _jsx(CapabilityPanel, { rsc: rsc, initialCount: Number.isSafeInteger(count) ? count : 2, queryLabel: queryLabel })] }));
}
export function DetailsPage({ params, searchParams }) {
    return (_jsxs("article", { className: "capability-shell", "data-testid": "plugin-details", "data-build": "v1", children: [_jsx("h1", { children: "Server-only details route \u00B7 v1" }), _jsx("pre", { "data-testid": "details-payload", children: JSON.stringify({ params, searchParams }, null, 2) })] }));
}
export async function SlowPage() {
    await new Promise((resolve) => setTimeout(resolve, 500));
    return (_jsx("article", { className: "capability-shell", "data-testid": "plugin-slow", "data-build": "v1", children: _jsx("h1", { children: "Delayed Flight render completed \u00B7 v1" }) }));
}
