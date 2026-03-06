import { type ResponsePluginFunction } from '@hile/http';
import { isValidElement } from 'react'
import { Context } from 'koa';
// import { renderToString } from 'react-dom/server';
// @ts-ignore
import { renderToPipeableStream, renderToString } from 'react-server-dom-webpack/server.node';

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
  const { pipe } = renderToPipeableStream(result, {});
  pipe(ctx.res);
}

function createSSRRender(ctx: Context, props: HTMLSSRProps, result: any) {
  const links = (props.links ?? []).map(link => `<link rel="stylesheet" href="${link}" />`).join('');
  const styles = (props.styles ?? []).map(style => `<style>${style}</style>`).join('');
  const scripts = (props.scripts ?? []).map(script => `<script src="${script}"></script>`).join('');
  const children = renderToString(result);

  const html = `<!doctype html>
<html>
  <head>
    <meta charset="utf-8" />
    <title>${props.title ?? ''}</title>
    ${links}
    ${styles}
    ${scripts}
  </head>
  <body>
    <div id="root">${children}</div>
  </body>
</html>`;

  ctx.status = 200;
  ctx.type = 'text/html; charset=utf-8';

  return html;
}
