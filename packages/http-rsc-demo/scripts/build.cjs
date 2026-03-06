/**
 * Copyright (c) Facebook, Inc. and its affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 */

'use strict';

const path = require('path');
const rimraf = require('rimraf');
const webpack = require('webpack');
const ReactServerWebpackPlugin = require('react-server-dom-webpack/plugin');
const MiniCssExtractPlugin = require('mini-css-extract-plugin');

const isProduction = process.env.NODE_ENV === 'production';
const cssLoader = isProduction ? MiniCssExtractPlugin.loader : 'style-loader';
rimraf.sync(path.resolve(__dirname, '../build'));
webpack(
  {
    mode: isProduction ? 'production' : 'development',
    devtool: isProduction ? 'source-map' : 'cheap-module-source-map',
    entry: [path.resolve(__dirname, '../src/client/app.ts')],
    output: {
      path: path.resolve(__dirname, '../build'),
      filename: 'main.js',
    },
    resolve: {
      modules: [
        path.resolve(__dirname, '../src/client'),
        'node_modules',
      ],
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
            cssLoader,
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
          use: [cssLoader, 'css-loader'],
        },
        {
          test: /\.less$/,
          exclude: /\.module\.less$/,
          use: [cssLoader, 'css-loader', 'less-loader'],
        },
      ],
    },
    plugins: [
      new ReactServerWebpackPlugin({isServer: false}),
      ...(isProduction ? [new MiniCssExtractPlugin({
        filename: '[name].css',
      })] : []),
    ],
  },
  (err, stats) => {
    if (err) {
      console.error(err.stack || err);
      // @ts-ignore
      if (err.details) {
        //@ts-ignore
        console.error(err.details);
      }
      process.exit(1);
      return;
    }
    const info = stats?.toJson();
    if (stats?.hasErrors()) {
      console.log('Finished running webpack with errors.');
      info?.errors?.forEach((e) => console.error(e));
      process.exit(1);
    } else {
      console.log('Finished running webpack.');
    }
  }
);
