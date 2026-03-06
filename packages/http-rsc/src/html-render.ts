import { type ResponsePluginFunction } from '@hile/http';
import { isValidElement } from 'react'
import { Context } from 'koa';
// @ts-ignore
import { renderToPipeableStream } from 'react-server-dom-webpack/server.node';

interface HTMLSSRProps {
  title?: string,
  scripts?: string[],
  styles?: string[],
  links?: string[],
}

export function createRSCPlugin(props: HTMLSSRProps): ResponsePluginFunction {
  return async (ctx, result, next) => {
    if (!isValidElement(result)) return await next(result);

    if (ctx.rsc) {
      createRSCRender(ctx, result);
    } else {
      await next(createSSRRender(ctx, props, result));
    }
  }
}

function createRSCRender(ctx: Context, result: any) {
  // 使用空的 bundler config（客户端会自己处理）
  const bundlerConfig = {};

  const { pipe } = renderToPipeableStream(result, bundlerConfig);

  // 设置正确的 Content-Type
  ctx.type = 'text/x-component';
  ctx.status = 200;

  pipe(ctx.res);
}

function createSSRRender(ctx: Context, props: HTMLSSRProps, result: any) {
  // const _html = createElement(HtmlShell, props, result);

  // const { pipe } = renderToPipeableStream(_html, {});

  // ctx.status = 200;
  // ctx.type = 'text/html; charset=utf-8';

  // pipe(ctx.res);
  return `
  <!doctype html>
  <html>
    <head>
      <meta charset="utf-8" />
      <title>${props.title ?? ''}</title>
      ${props.links?.map(link => `<link rel="stylesheet" href="${link}" />`).join('') ?? ''}
      ${props.styles?.map(style => `<style>${style}</style>`).join('') ?? ''}
      ${props.scripts?.map(script => `<script src="${script}"></script>`).join('') ?? ''}
    </head>
    <body>
      <div id="root"></div>
    </body>
  </html>
  `;
}
