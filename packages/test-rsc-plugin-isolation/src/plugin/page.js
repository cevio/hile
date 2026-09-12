import { jsx as _jsx, jsxs as _jsxs } from "react/jsx-runtime";
import IsolationWidget from './isolation-widget';
export function IsolationPage({ searchParams = {} }) {
    const marker = String(searchParams.marker ?? 'isolated');
    return (_jsxs("article", { className: "isolation-shell", "data-testid": "plugin-isolation", "data-build": "isolation-v1", children: [_jsxs("header", { className: "isolation-header", children: [_jsx("p", { children: "ISOLATED ARTIFACT \u00B7 INDEPENDENT CLIENT GRAPH" }), _jsx("h1", { children: "Independent plugin namespace" }), _jsx("span", { children: "This server tree, Ant Design theme, browser state, CSS and microservice are isolated from the capabilities plugin." })] }), _jsx(IsolationWidget, { marker: marker })] }));
}
export function InspectPage({ params = {}, searchParams = {} }) {
    return (_jsxs("article", { className: "isolation-shell", "data-testid": "isolation-inspect", children: [_jsx("h1", { children: "Independent server-only route" }), _jsx("pre", { children: JSON.stringify({ params, searchParams }, null, 2) })] }));
}
