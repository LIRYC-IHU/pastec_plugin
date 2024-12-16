/* eslint-disable import/no-commonjs */

const HtmlWebpackPlugin = require('html-webpack-plugin');
const webpack = require("webpack")
const CopyPlugin = require("copy-webpack-plugin");
const CopyWebpackPlugin = require('copy-webpack-plugin');
const path = require('path');

module.exports = {
  entry: {
    content: './src/content.js',
    auth: './src/auth.js',
    data_formatting: './src/data_formatting.js',
    microport_scraping: './src/microport_scraping.js',
    medtronic_scraping: './src/medtronic_scraping.js',
    biotronik_scraping: './src/biotronik_scraping.js',
    boston_scraping: './src/boston_scraping.js',
    abbott_scraping: './src/abbott_scraping.js',
    background: './src/background.js',
    "pdf.worker": "pdfjs-dist/build/pdf.worker.mjs",
  },
  output: {
    path: path.resolve(__dirname, 'dist'),
    publicPath: '',
    filename: '[name].js',
    globalObject: 'this',
  },
  module: {
    rules: [{
        test: /\.(js)$/,
        exclude: /node_modules/,
        use: {
            loader: 'babel-loader',
            options: {
                presets: ['@babel/preset-env']
            }
        }
    }],
  },
  plugins: [
    new CopyPlugin({
    patterns: [
      { from: "public" },
    ],
  }),
  ],
};