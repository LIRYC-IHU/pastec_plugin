const { merge } = require('webpack-merge');
const webpack = require('webpack');
const config = require('./webpack.config.js');
const dotenv = require('dotenv').config({ path: './.env-dev' });

module.exports = merge(config, {
    mode: 'development',
    devtool: 'inline-source-map',
    plugins: [
        new webpack.DefinePlugin({
            'process.env': JSON.stringify(dotenv.parsed)
        })
    ]
});