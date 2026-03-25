# PASTEC Chrome Extension

## Overview

The PASTEC Chrome extension helps research teams collect, pseudonymize, and annotate arrhythmia episodes from supported remote monitoring platforms.

It is intended for academic and multicenter research workflows. Most participating centers do not need to self-host the backend and can connect to the hosted academic instance after onboarding.

## Quick Start

### For participants

Install the published extension:

**[PASTEC Plugin on the Chrome Web Store](https://chromewebstore.google.com/detail/pastec-plugin/lkmeideppdcnbhjempijngghdpkecnlf)**

Then:

1. open the extension options page
2. check the backend URL if your center uses a non-default deployment
3. click `Connexion Keycloak`
4. sign in with your institutional PASTEC account
5. import the signed center bundle provided by your local admin

After that, the extension is ready to use on supported manufacturer websites.

### For development

```bash
git clone https://github.com/LIRYC-IHU/pastec_plugin.git
cd pastec_plugin
npm install
cp .env-dev.example .env-dev
# edit .env-dev
npm run dev
```

Load the unpacked build from `dist` in `chrome://extensions`.

For a production build:

```bash
cp .env-prod.example .env-prod
# edit .env-prod
npm run build
```

## User Workflow

Typical use:

1. log in to the manufacturer portal
2. open an episode with EGM data
3. let the extension detect the episode
4. select the diagnostic label in the PASTEC overlay
5. the extension pseudonymizes the identifiers locally
6. metadata and EGM files are uploaded to the backend
7. optional AI jobs are started and their status is shown in the overlay

For supported batch workflows such as Biotronik and Boston Scientific, the extension can process episodes sequentially.

## Authentication

### Keycloak login

The extension now authenticates with Keycloak using Authorization Code + PKCE.

What this means for users:

- login happens in a Keycloak window
- the extension does not store the user password locally
- access tokens are refreshed automatically when possible

The plugin still requires the user to log in separately to the manufacturer website in the normal way.

### Development and production Keycloak clients

Two Keycloak clients are used:

- `pastec_plugin_dev` for unpacked development builds
- `pastec_plugin_prod` for the Chrome Web Store build

This split is required because the OAuth redirect URI depends on the extension ID.

Typical redirect URIs:

- development: `https://<dev-extension-id>.chromiumapp.org/keycloak`
- production: `https://lkmeideppdcnbhjempijngghdpkecnlf.chromiumapp.org/keycloak`

### Why Chrome may show site access

The extension runs content scripts on supported manufacturer portals and, for some flows, needs access to the current website session. Chrome may therefore display that the extension can access supported websites. This is expected behavior for the scraping workflow.

## Center Bundle and Pepper

Each center uses a single center-specific pepper so that pseudonymization stays stable inside that center's dataset.

Users do not type the pepper manually. Instead, the plugin imports a signed JSON bundle that contains:

- the center identifier
- the center pepper
- optional backend URL metadata
- a backend signature verified locally by the plugin

The backend stores only the pepper hash used for verification during uploads.

## Critical Bundle Procedure

The signed center bundle is a critical file and must be handled by the local center administrator.

### Initial creation

1. the admin creates the center pepper from the backend admin route
2. the backend generates the pepper once
3. the backend immediately returns a signed bundle file
4. the admin downloads and stores that bundle locally

### Backup

The bundle must be backed up immediately.

Recommended practice:

1. keep one restricted institutional copy
2. keep one secondary backup copy under center control
3. document who is responsible for the bundle

### Distribution

1. the local admin distributes the bundle only to authorized users of that center
2. each user logs in with their own Keycloak account
3. each user imports the signed bundle into the extension options page

### Important warning

If the original center bundle is lost, the original pepper cannot be recovered from the backend. Generating a new pepper later would break pseudonymization continuity for that center.

## Supported Manufacturers

- Medtronic
- Biotronik
- Boston Scientific
- Abbott
- MicroPort

## What Is Uploaded

The extension standardizes episode data before upload. The backend receives pseudonymized identifiers and episode metadata such as:

- patient ID hash
- episode ID hash
- manufacturer
- episode type
- implant model
- episode duration
- age at episode
- optional clinician annotation

No reversible patient identifier is uploaded by the plugin.

## Error Handling

If an operation fails while the overlay is active, the extension now displays a small error popup in the top-left corner of the webpage in addition to the browser console logs.

## Environment Variables

Common variables:

```bash
API_URL=https://pastec.ihu-liryc.fr
KEYCLOAK_BASE_URL=https://pastec.ihu-liryc.fr/auth
KEYCLOAK_REALM=pastec
```

Client ID by build target:

```bash
# unpacked build
KEYCLOAK_CLIENT_ID=pastec_plugin_dev

# production build
KEYCLOAK_CLIENT_ID=pastec_plugin_prod
```

See:

- [`.env.example`](./.env.example)
- [`.env-dev.example`](./.env-dev.example)
- [`.env-prod.example`](./.env-prod.example)

## Project Structure

```text
chrome_ext/
├── src/
├── public/
├── webpack.config.js
├── webpack.dev.js
├── webpack.prod.js
└── package.json
```

## Related Documentation

- [backend README](../backend/README.md)
- [backend env reference](../backend/ENV_VARIABLES.md)

## Intended Use

PASTEC is intended for academic research workflows with institutional authorization. It is not a standalone medical device and is not intended for autonomous clinical decision making.

## License

See [LICENSE.md](./LICENSE.md).
