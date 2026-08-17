'use client';

import {
  App as AntdApp,
  Badge,
  ConfigProvider,
  Layout,
  Menu,
  Space,
  Tag,
  Typography,
  theme,
} from 'antd';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import type { ReactNode } from 'react';

const { Header, Sider, Content } = Layout;

export interface HostNavigationItem {
  key: string;
  label: string;
  href: string;
}

export default function HostShell({
  children,
  navigation,
}: {
  children: ReactNode;
  navigation: readonly HostNavigationItem[];
}) {
  const pathname = usePathname();
  const items = [
    { key: '/', label: <Link href="/">Runtime overview</Link> },
    ...navigation.map((item) => ({
      key: item.key,
      label: <Link href={item.href}>{item.label}</Link>,
    })),
  ];
  const selected = items.find(({ key }) => key !== '/' && pathname.startsWith(key))?.key ?? '/';

  return (
    <ConfigProvider
      theme={{
        algorithm: theme.defaultAlgorithm,
        token: {
          colorPrimary: '#0e7490',
          colorInfo: '#0e7490',
          colorSuccess: '#15803d',
          borderRadius: 6,
          fontFamily: '"IBM Plex Sans", "Noto Sans SC", sans-serif',
        },
        components: {
          Layout: { headerBg: '#071a24', siderBg: '#0b2533', bodyBg: '#eef3f4' },
          Menu: { darkItemBg: '#0b2533', darkItemSelectedBg: '#0e7490' },
        },
      }}
    >
      <AntdApp>
        <Layout className="host-layout" data-testid="host-application-shell">
          <Header className="host-header">
            <div className="host-wordmark">
              <span className="host-wordmark-mark">H</span>
              <div>
                <Typography.Text className="host-wordmark-title">HILE RSC CONTROL PLANE</Typography.Text>
                <Typography.Text className="host-wordmark-subtitle">Single-origin plugin runtime</Typography.Text>
              </div>
            </div>
            <Space size="small" wrap>
              <Badge status="processing" text={<span className="host-status-text">Registry connected</span>} />
              <Tag variant="filled" color="cyan">Flight</Tag>
              <Tag variant="filled" color="gold">React 19</Tag>
            </Space>
          </Header>
          <Layout>
            <Sider className="host-sider" width={236} breakpoint="lg" collapsedWidth={0}>
              <div className="host-nav-caption">WORKSPACE</div>
              <Menu theme="dark" mode="inline" selectedKeys={[selected]} items={items} />
              <div className="host-sider-foot">
                <span>PUBLIC EDGE</span>
                <strong>127.0.0.1:3200</strong>
                <small>Plugin services remain internal</small>
              </div>
            </Sider>
            <Content className="host-content">
              <div className="host-route-bar">
                <span>RSC HOST</span>
                <code>{pathname}</code>
              </div>
              <main className="host-plugin-content" data-testid="host-plugin-content">
                {children}
              </main>
            </Content>
          </Layout>
        </Layout>
      </AntdApp>
    </ConfigProvider>
  );
}
