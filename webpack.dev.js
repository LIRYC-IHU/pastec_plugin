const { merge } = require('webpack-merge');
const webpack = require('webpack');
const config = require('./webpack.config.js');
const dotenv = require('dotenv').config({ path: './.env-dev' });

const env = dotenv.parsed || {};
const apiUrl = env.API_URL || 'http://localhost:8000';
const keycloakBaseUrl = env.KEYCLOAK_BASE_URL || `${new URL(apiUrl).origin}/auth`;
const keycloakRealm = env.KEYCLOAK_REALM || 'pastec';
const keycloakClientId = env.KEYCLOAK_CLIENT_ID || 'pastec_plugin_dev';

module.exports = merge(config, {
    mode: 'development',
    devtool: 'inline-source-map',
    plugins: [
        new webpack.DefinePlugin({
            'process.env.API_URL': JSON.stringify(apiUrl),
            'process.env.KEYCLOAK_BASE_URL': JSON.stringify(keycloakBaseUrl),
            'process.env.KEYCLOAK_REALM': JSON.stringify(keycloakRealm),
            'process.env.KEYCLOAK_CLIENT_ID': JSON.stringify(keycloakClientId)
        })
    ]
});
