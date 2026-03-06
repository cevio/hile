import { type Middleware } from "koa"
import Webpack from 'webpack';
import WebpackDevMiddleware from 'webpack-dev-middleware';
import c2k from 'koa-connect';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from "node:url";
// @ts-ignore
import ReactServerWebpackPlugin from 'react-server-dom-webpack/plugin';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

export function createWebpackMiddleware(options: {
  clientComponentsDir?: string;
} = {}): Middleware {
  const clientDir = options.clientComponentsDir || resolve(process.cwd(), 'src/client');

  const webpack = Webpack({
    target: process.env.NODE_ENV === 'development' ? 'web' : 'node',
    mode: process.env.NODE_ENV === 'development' ? 'development' : 'production',
    entry: resolve(__dirname, 'react-shell.js'),
    output: {
      filename: process.env.NODE_ENV === 'development' ? 'bundle.js' : 'bundle.[contenthash:8].js',
      path: resolve(process.cwd(), 'resources'),
      publicPath: '/',
    },
    resolve: {
      extensions: ['.js', '.jsx', '.ts', '.tsx'],
      alias: {
        '@client': clientDir,
      },
    },
    module: {
      rules: [
        {
          test: /\.(js|jsx|ts|tsx)$/,
          exclude: /node_modules/,
          use: {
            loader: 'babel-loader',
            options: {
              presets: [
                '@babel/preset-react',
                '@babel/preset-typescript',
              ],
            },
          },
        },
        {
          test: /\.module\.(css|less)$/,
          use: [
            'style-loader',
            {
              loader: 'css-loader',
              options: {
                modules: {
                  localIdentName: '[name]__[local]--[hash:base64:5]',
                },
              },
            },
            'less-loader',
          ],
        },
        {
          test: /\.css$/,
          exclude: /\.module\.css$/,
          use: ['style-loader', 'css-loader'],
        },
        {
          test: /\.less$/,
          exclude: /\.module\.less$/,
          use: ['style-loader', 'css-loader', 'less-loader'],
        },
      ],
    },
    plugins: [
      new ReactServerWebpackPlugin({
        isServer: process.env.NODE_ENV === 'development' ? false : true,
      }),
    ],
  });

  return c2k(WebpackDevMiddleware(webpack, {
    publicPath: '/',
    writeToDisk: false,
  }));
}