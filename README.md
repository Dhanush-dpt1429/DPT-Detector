# DPT-Detector — Real Web App

A production-oriented full-stack version of DPT-Detector.

## What is real here?

### 🔍 Plagiarism Check
The backend submits the user's text to the Copyleaks Plagiarism Checker API with internet scanning enabled. Copyleaks supports identical, minor-change and paraphrased matches and returns source URLs and matched-word counts. The API is asynchronous and calls your public webhook when the scan completes.

### ✍️ Rewrite Naturally
The backend uses the OpenAI Responses API. The API key stays server-side in an environment variable and is never placed in the frontend.

### 📊 Readability
Runs locally in the browser, so it needs no API.

### 📝 Writing Tools
Runs locally in the browser.

## Important deployment architecture

GitHub Pages can host the frontend, but it cannot safely hold private API keys or receive Copyleaks webhooks. Therefore:

- `frontend/index.html` → GitHub Pages
- `backend/server.js` → a server that has a public HTTPS URL
- Copyleaks → real plagiarism scans + webhook results
- OpenAI → real rewriting

The frontend has `API_BASE` set to `http://localhost:8787` for local development. When the frontend is hosted on GitHub Pages, change `API_BASE` near the top of the script to your deployed backend URL.

## Setup

1. Install Node.js 20+.
2. Run:
   npm install
3. Copy `.env.example` to `.env`.
4. Add your Copyleaks and OpenAI credentials.
5. Set `PUBLIC_BACKEND_URL` to the public HTTPS URL of this backend.
6. Start:
   npm start

For local testing of the full webhook flow, your backend must be reachable from the public internet. A production deployment is recommended.

## GitHub Pages

Put `frontend/index.html` into a GitHub repository and enable GitHub Pages.

If you want the backend in the same repository, keep the structure:

frontend/
backend/
package.json
.env.example

Do NOT commit `.env`.

## Production notes

This sample keeps pending scan state in process memory. For a multi-instance production service, use a persistent database/Redis store for scan state and webhook results. Also add authentication, rate limiting, abuse protection, request logging, and a privacy/retention policy before opening the service to the public.

The 5,000-word limit is enforced on both the frontend and backend.

## Provider notes

Copyleaks requires webhook endpoints for authenticity scans. Their documentation recommends securing webhook endpoints with HTTPS and/or a developer payload. This project sends a unique developer payload equal to the scan ID and should be extended with stronger webhook verification for a public production deployment.
