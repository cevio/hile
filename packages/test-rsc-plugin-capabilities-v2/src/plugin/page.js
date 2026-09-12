import { jsx as _jsx, jsxs as _jsxs } from "react/jsx-runtime";
import UpdatePanel from './update-panel';
import { RscLink } from '@hile/rsc/client/navigation';
export async function CapabilitiesPage({ searchParams, rsc }) {
    await Promise.resolve();
    return (_jsxs("article", { className: "capability-v2", "data-testid": "plugin-capabilities", "data-build": "v2", children: [_jsxs("header", { className: "capability-v2-header", children: [_jsx("p", { className: "capability-v2-kicker", children: "REMOTE SERVER COMPONENT \u00B7 LIVE BUILD" }), _jsx("h1", { children: "Capabilities plugin \u00B7 build v2" }), _jsx("p", { children: "This heading and request metadata were rendered inside the plugin service. The interactive Ant Design workspace below crosses into an independently compiled Client Component graph." }), _jsxs("dl", { className: "capability-v2-metadata", children: [_jsxs("div", { children: [_jsx("dt", { children: "Query label" }), _jsx("dd", { "data-testid": "server-query", children: String(searchParams.label ?? 'default-label') })] }), _jsxs("div", { children: [_jsx("dt", { children: "Resolved build" }), _jsx("dd", { children: rsc.buildId })] }), _jsxs("div", { children: [_jsx("dt", { children: "Transport" }), _jsx("dd", { children: "React Flight stream" })] })] }), _jsx(RscLink, { "data-testid": "remote-rsc-navigation", href: "/plugins/demo.rsc.capabilities/details?source=remote-link", children: "Open remote details" })] }), _jsx(UpdatePanel, { initialValue: 10, rsc: rsc })] }));
}
export function DetailsPage({ params, searchParams }) {
    return (_jsxs("article", { className: "capability-v2", "data-testid": "plugin-details", "data-build": "v2", children: [_jsx("h1", { children: "Server-only details route \u00B7 v2" }), _jsx("pre", { children: JSON.stringify({ params, searchParams }, null, 2) })] }));
}
export async function SlowPage() {
    await new Promise((resolve) => setTimeout(resolve, 500));
    return _jsx("article", { className: "capability-v2", "data-testid": "plugin-slow", "data-build": "v2", children: "Delayed v2 render" });
}
