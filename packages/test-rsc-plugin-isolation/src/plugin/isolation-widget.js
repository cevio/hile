'use client';
import { jsx as _jsx, jsxs as _jsxs } from "react/jsx-runtime";
import { Alert, Badge, Card, Col, ConfigProvider, Descriptions, Input, Row, Segmented, Slider, Space, Switch, Tag, Typography, } from 'antd';
import { useId, useMemo, useState } from 'react';
import './isolation.css';
export default function IsolationWidget({ marker }) {
    const id = useId();
    const [value, setValue] = useState(marker);
    const [mode, setMode] = useState('Local state');
    const [density, setDensity] = useState(56);
    const [enabled, setEnabled] = useState(true);
    const fingerprint = useMemo(() => `${value.length}-${mode.toLowerCase().replace(' ', '-')}`, [value, mode]);
    return (_jsx(ConfigProvider, { theme: { token: { colorPrimary: '#c2410c', colorInfo: '#c2410c', borderRadius: 2 } }, children: _jsxs("section", { className: "isolation-widget", "data-testid": "isolation-client", children: [_jsx(Alert, { showIcon: true, type: "warning", title: "No client state crosses the plugin boundary", description: "Edit the controls below, then navigate to another plugin. Its client graph remains unaffected." }), _jsxs(Row, { gutter: [16, 16], children: [_jsx(Col, { xs: 24, lg: 15, children: _jsx(Card, { title: "Independent state controls", extra: _jsx(Badge, { status: enabled ? 'success' : 'default', text: enabled ? 'active' : 'paused' }), children: _jsxs(Space, { orientation: "vertical", size: "large", className: "isolation-controls", children: [_jsx("label", { htmlFor: id, children: "Independent client state" }), _jsx(Input, { id: id, value: value, disabled: !enabled, onChange: (event) => setValue(event.target.value) }), _jsxs("div", { children: [_jsx(Typography.Text, { type: "secondary", children: "State strategy" }), _jsx(Segmented, { block: true, value: mode, options: ['Local state', 'Reducer', 'External store'], onChange: setMode })] }), _jsxs("div", { children: [_jsxs(Typography.Text, { type: "secondary", children: ["Visual density: ", density, "%"] }), _jsx(Slider, { min: 20, max: 100, value: density, onChange: setDensity })] }), _jsxs(Space, { children: [_jsx(Switch, { checked: enabled, onChange: setEnabled }), _jsx("span", { children: "Client island enabled" })] })] }) }) }), _jsx(Col, { xs: 24, lg: 9, children: _jsxs(Card, { title: "Boundary probe", className: "isolation-probe", children: [_jsx(Tag, { color: "volcano", children: "demo.rsc.isolation" }), _jsx(Typography.Title, { level: 4, "data-testid": "isolation-value", children: value }), _jsx(Descriptions, { column: 1, size: "small", items: [
                                            { key: 'marker', label: 'Server seed', children: marker },
                                            { key: 'mode', label: 'Client mode', children: mode },
                                            { key: 'fingerprint', label: 'Fingerprint', children: fingerprint },
                                        ] })] }) })] })] }) }));
}
