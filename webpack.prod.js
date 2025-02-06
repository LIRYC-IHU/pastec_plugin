const { merge } = require('webpack-merge');
const config = require('./webpack.config.js');
const webpack = require('webpack');
const dotenv = require('dotenv').config({ path: './.env-prod' });

module.exports = merge(config, {
    mode: 'production',
    plugins: [
        new webpack.DefinePlugin({
            'process.env.API_URL': JSON.stringify('https://pastec.ihu-liryc.fr')
        })
    ]
});