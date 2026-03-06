import { type Middleware } from "koa"
import Webpack from 'webpack';
import WebpackDevMiddleware from 'webpack-dev-middleware';
import c2k from 'koa-connect';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);


export function createWebpackMiddleware(): Middleware {
  const webpack = Webpack({
    mode: 'development',
    entry: resolve(__dirname, 'react-shell.js'),
    output: {
      filename: 'bundle.js',
      path: resolve(process.cwd(), 'resources'),
    },
  });
  return c2k(WebpackDevMiddleware(webpack));
}