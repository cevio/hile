import { defineService } from '@hile/core';
import HttpNext from '@hile/http-next';
import {
  createMcpHmacInvocationCredentialCodec,
  createMcpInvocationCredentialKeyring,
} from '@hile/mcp';
import { createMcpGateway } from '@hile/mcp/gateway';
import { createMcpHttpEndpoint } from '@hile/mcp/http';
import { createHileMcpProviderSource } from '@hile/mcp/micro';
import { OAuthError, OAuthErrorCode } from '@modelcontextprotocol/server';
import { Application } from '@hile/micro';
import {
  createRscActionMiddleware,
  createSameOriginCsrfAuthorizer,
  RscActionGateway,
} from '@hile/rsc/host/actions';
import { createRscAssetMiddleware } from '@hile/rsc/host/assets';
import {
  createRscServerFunctionMiddleware,
  RscServerFunctionGateway,
} from '@hile/rsc/host/server-functions';
import {
  RscDevelopmentEvents,
  createRscDevelopmentEventMiddleware,
} from '@hile/rsc-development/host';
import {
  createCatalogRscPluginLocator,
  InMemoryRscDeploymentCatalog,
} from '@hile/rsc/host/catalog';
import { mountRscHostAdapters } from '@hile/rsc/host/mount';
import {
  createRemoteClientResolver,
  createRscAssetUrls,
  InMemoryRscArtifactCatalog,
  installRemoteClientResolver,
} from '@hile/rsc/host/registry';
import { HILE_RSC_RUNTIME } from '@hile/rsc/protocol';
import {
  attachRscDeploymentCatalog,
  createHileRscPluginClient,
} from '@hile/rsc/transport';
import { createHmacRscDiscoveryAuthorizer, HileRscDiscoveryHost } from '@hile/rsc-discovery-hile';
import {
  DEMO_HOST_SERVICE_KEY,
  installDemoHostComposition,
  type DemoHostComposition,
} from './runtime-reference';

const discoveryGenerationHighWater = new Map();

export default defineService<DemoHostComposition>(DEMO_HOST_SERVICE_KEY, async (shutdown) => {
  const hostRoot = process.cwd();
  const artifacts = new InMemoryRscArtifactCatalog();
  const deployments = new InMemoryRscDeploymentCatalog();
  const application = new Application({
    namespace: process.env.HOST_MICRO_NAMESPACE ?? 'demo.rsc.host',
    advertiseHost: process.env.HILE_ADVERTISE_HOST ?? '127.0.0.1',
    registry: {
      host: process.env.REGISTRY_HOST ?? '127.0.0.1',
      port: Number(process.env.REGISTRY_PORT ?? 9876),
    },
  });
  const detachCatalog = attachRscDeploymentCatalog(deployments, application);
  const stopMicro = await application.listen(Number(process.env.HOST_MICRO_PORT ?? 4210));
  const mcpSource = createHileMcpProviderSource(application, {
    pollIntervalMs: Number(process.env.MCP_DISCOVERY_POLL_MS ?? 250),
    onError: console.error,
  });
  const mcpGateway = await createMcpGateway({
    source: mcpSource,
    info: { name: 'test-rsc-host', version: '1.0.0' },
    instructions: 'Use catalog resources for grounding. Order tools are provided by the isolated plugin service.',
    cacheHints: {
      'tools/list': { ttlMs: 30_000, cacheScope: 'public' },
      'resources/read': { ttlMs: 15_000, cacheScope: 'private' },
    },
    startup: 'allow-empty',
    invocationSecurity: {
      mode: 'credential',
      credentials: createMcpInvocationCredentialKeyring({
        catalog: createMcpHmacInvocationCredentialCodec({
          issuer: 'test-rsc-host',
          secret: process.env.MCP_CATALOG_SECRET ?? 'test-rsc-catalog-provider-secret-32-bytes',
        }),
        orders: createMcpHmacInvocationCredentialCodec({
          issuer: 'test-rsc-host',
          secret: process.env.MCP_ORDERS_SECRET ?? 'test-rsc-orders-provider-secret-32-bytes!',
        }),
        labs: createMcpHmacInvocationCredentialCodec({
          issuer: 'test-rsc-host',
          secret: process.env.MCP_ORDERS_SECRET ?? 'test-rsc-orders-provider-secret-32-bytes!',
        }),
      }),
    },
    onError: console.error,
  });
  const locator = createCatalogRscPluginLocator(
    deployments,
    async (deployment) => createHileRscPluginClient(application, deployment.namespace),
  );
  const developmentEvents = new RscDevelopmentEvents();
  const developmentRevision = new Map<string, number>();
  const discovery = new HileRscDiscoveryHost({
    application,
    artifacts,
    deployments,
    runtime: HILE_RSC_RUNTIME,
    pollIntervalMs: Number(process.env.RSC_DISCOVERY_POLL_MS ?? 250),
    missingReconciliations: Number(process.env.RSC_DISCOVERY_MISSING_RECONCILIATIONS ?? 3),
    snapshotConcurrency: Number(process.env.RSC_DISCOVERY_SNAPSHOT_CONCURRENCY ?? 16),
    generationHighWater: discoveryGenerationHighWater,
    authorize: createHmacRscDiscoveryAuthorizer((keyId) => {
      if (keyId === 'demo-capabilities') return {
        secret: process.env.RSC_CAPABILITIES_DISCOVERY_SECRET ?? 'demo-capabilities-secret',
        pluginIds: ['demo.rsc.capabilities'],
        requireGeneration: true,
      };
      if (keyId === 'demo-isolation') return {
        secret: process.env.RSC_ISOLATION_DISCOVERY_SECRET ?? 'demo-isolation-secret',
        pluginIds: ['demo.rsc.isolation'],
        requireGeneration: true,
      };
      return undefined;
    }),
    onRejected: (topic, error) => console.error(`Rejected RSC discovery topic ${topic}`, error),
    onError: console.error,
    onEnabled: (announcement) => {
      const revision = (developmentRevision.get(announcement.pluginId) ?? 0) + 1;
      developmentRevision.set(announcement.pluginId, revision);
      developmentEvents.publish({
        pluginId: announcement.pluginId,
        buildId: announcement.buildId,
        revision,
      });
    },
  });
  try {
    await discovery.start();
  } catch (error) {
    await discovery.close().catch(() => undefined);
    await mcpGateway.close().catch(() => undefined);
    detachCatalog();
    await stopMicro();
    throw error;
  }

  const assetMountPath = '/_hile/rsc/assets';
  const uninstallResolver = installRemoteClientResolver(
    createRemoteClientResolver(artifacts, createRscAssetUrls(assetMountPath)),
  );
  const authorize = createSameOriginCsrfAuthorizer({
    expectedOrigin: process.env.RSC_DEMO_ORIGIN ?? 'http://127.0.0.1:3200',
    readToken: (context) => {
      const entry = Object.entries(context.headers ?? {})
        .find(([name]) => name.toLowerCase() === 'x-rsc-demo-token')?.[1];
      return Array.isArray(entry) ? entry[0] : entry;
    },
    verifyToken: (token) => token === (process.env.RSC_DEMO_TOKEN ?? 'demo-token'),
  });
  const actionGateway = new RscActionGateway({ locator, authorize });
  const actionMiddleware = createRscActionMiddleware({ gateway: actionGateway });
  const serverFunctionGateway = new RscServerFunctionGateway({
    locator,
    authorize: (request, context) => authorize({
      pluginId: request.pluginId,
      buildId: request.buildId,
      actionId: request.referenceId,
      input: {},
    }, context),
  });
  const serverFunctionMiddleware = createRscServerFunctionMiddleware({ gateway: serverFunctionGateway });
  const host = new HttpNext({
    port: Number(process.env.HTTP_PORT ?? 3200),
    cwd: hostRoot,
  });
  const mcpEndpoint = createMcpHttpEndpoint(mcpGateway, {
    path: '/mcp',
    security: {
      allowedHostnames: ['127.0.0.1', 'localhost'],
      allowedOriginHostnames: ['127.0.0.1', 'localhost'],
      authentication: {
        mode: 'oauth',
        verifier: {
          async verifyAccessToken(token) {
            if (token !== 'demo-mcp-token') throw new OAuthError(OAuthErrorCode.InvalidToken, 'Invalid demo MCP token');
            return {
              token,
              clientId: 'test-rsc-demo-suite',
              scopes: ['mcp:access', 'catalog:read', 'orders:write'],
              expiresAt: Math.floor(Date.now() / 1_000) + 3_600,
            };
          },
        },
        requiredScopes: ['mcp:access'],
        metadata: {
          resourceServerUrl: new URL(process.env.MCP_PUBLIC_URL ?? 'http://127.0.0.1:3200/mcp'),
          resourceName: 'Hile MCP interactive demo',
          scopesSupported: ['mcp:access', 'catalog:read', 'orders:write'],
          oauthMetadata: {
            issuer: 'https://auth.demo.invalid',
            authorization_endpoint: 'https://auth.demo.invalid/authorize',
            token_endpoint: 'https://auth.demo.invalid/token',
            response_types_supported: ['code'],
          },
        },
      },
    },
    legacy: 'reject',
    keepAliveMs: 5_000,
    onError: console.error,
  });
  host.use(mcpEndpoint.middleware);
  mountRscHostAdapters(host, {
    asset: createRscAssetMiddleware({ catalog: artifacts, mountPath: assetMountPath }),
    action: async (context, next) => {
      context.requestContext = { headers: context.headers };
      return actionMiddleware(context, next);
    },
    serverFunction: async (context, next) => {
      context.requestContext = { headers: context.headers };
      return serverFunctionMiddleware(context, next);
    },
    middleware: process.env.RSC_DEVELOPMENT_STATE ? [
      createRscDevelopmentEventMiddleware({ events: developmentEvents }),
    ] : [],
  });
  const composition: DemoHostComposition = {
    application,
    deployments,
    discovery,
    locator,
    assetMountPath,
  };
  const uninstallComposition = installDemoHostComposition(composition);
  let stopHttp: () => Promise<void>;
  try {
    stopHttp = await host.start();
  } catch (error) {
    uninstallComposition();
    uninstallResolver();
    await mcpEndpoint.close().catch(() => undefined);
    await mcpGateway.close().catch(() => undefined);
    await discovery.close();
    detachCatalog();
    await stopMicro();
    throw error;
  }

  shutdown(async () => {
    uninstallComposition();
    uninstallResolver();
    await stopHttp();
    await mcpEndpoint.close();
    await mcpGateway.close();
    await discovery.close();
    detachCatalog();
    await stopMicro();
  });

  return composition;
});
