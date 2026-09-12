'use client';
import { jsx as _jsx, jsxs as _jsxs } from "react/jsx-runtime";
import { App as AntdApp, Alert, Badge, Button, Card, Col, Collapse, ConfigProvider, Row, Skeleton, Space, Statistic, Tag, Typography, } from 'antd';
import { createContext, lazy, Suspense, useContext, useEffect, useReducer, useState, useTransition, } from 'react';
import './capabilities.css';
const LazyInspector = lazy(() => import('./lazy-inspector'));
const AccentContext = createContext('violet');
function Counter({ initialCount }) {
    const accent = useContext(AccentContext);
    const [count, increment] = useReducer((value) => value + 1, initialCount);
    return (_jsxs(Card, { size: "small", title: "Context + reducer", "data-accent": accent, children: [_jsx(Statistic, { title: "Hydrated reducer value", value: count, styles: { content: { color: '#6d28d9' } } }), _jsx("output", { className: "capability-visually-hidden", "data-testid": "counter-value", children: count }), _jsx(Button, { type: "primary", onClick: () => increment(), "data-testid": "increment-client", children: "Increment in browser" })] }));
}
function CapabilityWorkspace({ rsc, initialCount, queryLabel }) {
    const { message } = AntdApp.useApp();
    const [hydrated, setHydrated] = useState(false);
    const [showLazy, setShowLazy] = useState(false);
    const [actionResult, setActionResult] = useState('not invoked');
    const [isPending, startTransition] = useTransition();
    useEffect(() => setHydrated(true), []);
    async function invokeRemoteAction() {
        const response = await fetch(`/_hile/rsc/actions/${encodeURIComponent(rsc.pluginId)}/${encodeURIComponent(rsc.buildId)}/increment`, {
            method: 'POST',
            headers: { 'content-type': 'application/json', 'x-rsc-demo-token': 'demo-token' },
            body: JSON.stringify({ input: { value: initialCount } }),
        });
        if (!response.ok)
            throw new Error(`Remote action failed: ${response.status}`);
        const result = await response.json();
        setActionResult(`${result.buildId}:${result.value}:call-${result.calls}`);
        void message.success('Model action returned through the Host gateway');
    }
    return (_jsxs("section", { className: "capability-panel", "data-testid": "capability-client-panel", children: [_jsxs("div", { className: "capability-runtime-line", children: [_jsx(Badge, { status: hydrated ? 'success' : 'processing', text: _jsx("span", { "data-testid": "hydration-state", children: hydrated ? 'hydrated' : 'server-rendered' }) }), _jsxs(Space, { wrap: true, children: [_jsx(Tag, { color: "purple", children: rsc.buildId }), _jsx(Tag, { children: rsc.pluginId })] })] }), _jsx(Alert, { showIcon: true, type: "info", title: "Serialized Server \u2192 Client props", description: _jsxs("span", { "data-testid": "query-label", children: ["Query label: ", queryLabel] }) }), _jsxs(Row, { gutter: [14, 14], children: [_jsx(Col, { xs: 24, md: 10, children: _jsx(Counter, { initialCount: initialCount }) }), _jsx(Col, { xs: 24, md: 14, children: _jsxs(Card, { size: "small", title: "Chunk and action controls", className: "capability-control-card", children: [_jsxs(Space, { wrap: true, children: [_jsx(Button, { "data-testid": "load-lazy", onClick: () => startTransition(() => setShowLazy(true)), children: isPending ? 'Loading…' : 'Load lazy client chunk' }), _jsx(Button, { type: "primary", ghost: true, "data-testid": "invoke-action", onClick: () => void invokeRemoteAction(), children: "Invoke internal plugin action" })] }), _jsxs(Typography.Paragraph, { className: "capability-result", children: ["Result: ", _jsx(Typography.Text, { code: true, "data-testid": "action-result", children: actionResult })] })] }) })] }), showLazy ? (_jsx(Suspense, { fallback: _jsx(Card, { children: _jsx(Skeleton, { active: true, paragraph: { rows: 2 }, "data-testid": "lazy-fallback" }) }), children: _jsx(LazyInspector, { buildId: rsc.buildId }) })) : null, _jsx(Collapse, { size: "small", items: [{
                        key: 'composition',
                        label: 'Why this is still an RSC plugin',
                        children: 'The server page stays in the plugin service; only explicitly marked client references and their chunks execute in the browser.',
                    }] })] }));
}
export default function CapabilityPanel(props) {
    return (_jsx(AccentContext.Provider, { value: "violet", children: _jsx(ConfigProvider, { theme: { token: { colorPrimary: '#6d28d9', borderRadius: 5 } }, children: _jsx(AntdApp, { children: _jsx(CapabilityWorkspace, { ...props }) }) }) }));
}
