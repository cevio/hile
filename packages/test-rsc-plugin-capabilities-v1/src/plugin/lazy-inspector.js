'use client';
import { jsx as _jsx, jsxs as _jsxs } from "react/jsx-runtime";
import { Alert, Descriptions } from 'antd';
export default function LazyInspector({ buildId }) {
    return (_jsxs("aside", { className: "capability-lazy", "data-testid": "lazy-inspector", children: [_jsx(Alert, { type: "success", showIcon: true, title: "Lazy client chunk loaded independently" }), _jsx(Descriptions, { size: "small", column: 1, items: [
                    { key: 'build', label: 'Build', children: buildId },
                    { key: 'boundary', label: 'Boundary', children: 'React.lazy + Suspense' },
                    { key: 'delivery', label: 'Delivery', children: 'Plugin-owned browser chunk' },
                ] })] }));
}
