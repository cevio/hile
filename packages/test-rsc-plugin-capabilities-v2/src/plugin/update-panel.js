'use client';
import { jsx as _jsx, jsxs as _jsxs } from "react/jsx-runtime";
import { App as AntdApp, Alert, Badge, Button, Card, Col, ConfigProvider, Descriptions, Form, InputNumber, Modal, Progress, Row, Space, Statistic, Table, Tabs, Tag, Timeline, Typography, } from 'antd';
import { useActionState, useEffect, useState } from 'react';
import { incrementWithServerFunction } from './actions';
import './update.css';
const capabilityRows = [
    { key: 'server', boundary: 'Server Component', owner: 'Plugin microservice', evidence: 'Request metadata in initial Flight' },
    { key: 'client', boundary: "'use client'", owner: 'Browser graph', evidence: 'Form, tabs, modal and local state' },
    { key: 'action', boundary: "'use server'", owner: 'Server Function → @hile/model', evidence: 'Same-origin Host gateway and microservice execution' },
    { key: 'style', boundary: 'Component library', owner: 'Independent artifact', evidence: 'Ant Design bundled per plugin' },
];
function InteractiveWorkspace({ initialValue, rsc }) {
    const { notification } = AntdApp.useApp();
    const [hydrated, setHydrated] = useState(false);
    const [inputValue, setInputValue] = useState(initialValue);
    const [modalOpen, setModalOpen] = useState(false);
    const [actionState, formAction, pending] = useActionState(incrementWithServerFunction, {
        buildId: 'v2', value: initialValue, invoked: false,
    });
    const result = actionState.invoked ? `${actionState.buildId}:${actionState.value}` : 'not invoked';
    useEffect(() => setHydrated(true), []);
    useEffect(() => {
        if (!actionState.invoked)
            return;
        notification.success({
            title: 'Server Function completed',
            description: `Build ${actionState.buildId} model returned ${actionState.value}.`,
            placement: 'bottomRight',
        });
    }, [actionState, notification]);
    return (_jsxs("section", { className: "update-panel", "data-testid": "update-client-panel", children: [_jsxs("div", { className: "update-status-line", children: [_jsx(Badge, { status: hydrated ? 'success' : 'processing', text: _jsx("span", { "data-testid": "v2-hydration", children: hydrated ? 'hydrated-v2' : 'server-rendered-v2' }) }), _jsxs(Space, { wrap: true, children: [_jsx(Tag, { color: "cyan", children: rsc.pluginId }), _jsx(Tag, { color: "gold", children: rsc.buildId })] })] }), _jsx(Tabs, { defaultActiveKey: "action", items: [
                    {
                        key: 'action',
                        label: 'Server Function',
                        children: (_jsxs(Row, { gutter: [16, 16], children: [_jsx(Col, { xs: 24, lg: 15, children: _jsxs(Card, { title: "Same-origin Server Function gateway", className: "update-action-card", children: [_jsx(Alert, { type: "info", showIcon: true, title: "React Server Function crosses the Host gateway, then invokes the plugin's scanned model." }), _jsxs("form", { action: formAction, className: "update-form", "data-testid": "v2-server-function-form", children: [_jsxs(Form.Item, { label: "Input value", help: "The v2 model adds 100 to this value.", children: [_jsx(InputNumber, { min: -1000, max: 1000, value: inputValue, onChange: (value) => setInputValue(value ?? 0) }), _jsx("input", { type: "hidden", name: "value", value: inputValue })] }), _jsxs(Space, { wrap: true, children: [_jsx(Button, { htmlType: "submit", type: "primary", loading: pending, "data-testid": "invoke-v2-action", children: "Invoke Server Function" }), _jsx(Button, { "data-testid": "open-v2-modal", onClick: () => setModalOpen(true), children: "Open client modal" })] })] })] }) }), _jsx(Col, { xs: 24, lg: 9, children: _jsxs(Card, { title: "Execution result", className: "update-result-card", children: [_jsx(Statistic, { title: "Model output", value: result, styles: { content: { fontSize: 22 } } }), _jsx("output", { className: "update-result-output", "data-testid": "v2-action-result", children: result }), _jsx(Progress, { percent: result === 'not invoked' ? 25 : 100, status: result === 'not invoked' ? 'active' : 'success', showInfo: false })] }) })] })),
                    },
                    {
                        key: 'matrix',
                        label: 'Component matrix',
                        children: (_jsx("div", { "data-testid": "component-matrix", children: _jsx(Table, { rowKey: "key", pagination: false, size: "small", dataSource: capabilityRows, columns: [
                                    { title: 'Boundary', dataIndex: 'boundary', key: 'boundary', render: (value) => _jsx(Typography.Text, { strong: true, children: value }) },
                                    { title: 'Runtime owner', dataIndex: 'owner', key: 'owner' },
                                    { title: 'Visible evidence', dataIndex: 'evidence', key: 'evidence' },
                                ], scroll: { x: 620 } }) })),
                    },
                    {
                        key: 'timeline',
                        label: 'Render lifecycle',
                        children: _jsx(Timeline, { items: [
                                { color: 'green', content: 'Registry resolves and verifies the active immutable build.' },
                                { color: 'blue', content: 'Plugin service renders the server graph into a Flight stream.' },
                                { color: 'blue', content: 'Host decodes Flight and places the tree inside its outer layout.' },
                                { color: hydrated ? 'green' : 'gray', content: 'Browser loads client references and hydrates interactive islands.' },
                            ] }),
                    },
                ] }), _jsxs(Modal, { open: modalOpen, title: "Client Component modal", closable: false, footer: _jsx(Button, { type: "primary", onClick: () => setModalOpen(false), children: "Close demonstration" }), children: [_jsx(Descriptions, { column: 1, bordered: true, size: "small", items: [
                            { key: 'plugin', label: 'Plugin', children: rsc.pluginId },
                            { key: 'build', label: 'Build', children: rsc.buildId },
                            { key: 'state', label: 'Local input', children: inputValue },
                        ] }), _jsx(Typography.Paragraph, { className: "update-modal-note", children: "This modal state exists only in the remote plugin client graph; the surrounding navigation remains owned by the Host." })] })] }));
}
export default function UpdatePanel(props) {
    return (_jsx(ConfigProvider, { theme: { token: { colorPrimary: '#087f5b', borderRadius: 4 } }, children: _jsx(AntdApp, { children: _jsx(InteractiveWorkspace, { ...props }) }) }));
}
