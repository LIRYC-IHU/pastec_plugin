const { merge } = require('webpack-merge');
const config = require('./webpack.config.js');
const webpack = require('webpack');
const dotenv = require('dotenv').config({ path: './.env-prod' });

const env = dotenv.parsed || {};
const apiUrl = env.API_URL || 'https://pastec.ihu-liryc.fr';
const keycloakBaseUrl = env.KEYCLOAK_BASE_URL || `${new URL(apiUrl).origin}/auth`;
const keycloakRealm = env.KEYCLOAK_REALM || 'pastec';
const keycloakClientId = env.KEYCLOAK_CLIENT_ID || 'pastec_plugin_prod';

module.exports = merge(config, {
    mode: 'production',
    plugins: [
        new webpack.DefinePlugin({
            'process.env.API_URL': JSON.stringify(apiUrl),
            'process.env.KEYCLOAK_BASE_URL': JSON.stringify(keycloakBaseUrl),
            'process.env.KEYCLOAK_REALM': JSON.stringify(keycloakRealm),
            'process.env.KEYCLOAK_CLIENT_ID': JSON.stringify(keycloakClientId)
        })
    ]
});
