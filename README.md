# Smart Capturer â€” Revision 1

iPhone-first PWA for capturing **images, links, and data**, attempting context automatically, letting the family correct it, and optionally reusing the same context for a batch.

## Rev 1
- iPhone camera capture (`capture="environment"`)
- Multiple-image selection
- Link and free-form data capture
- Gemini image/text context analysis by default, with an optional OpenAI adapter
- Editable category, title, context, tags, and destination
- Shared-context batch mode
- Family access code (`CAPTURE_ACCESS_KEY`)
- Durable Google Cloud Storage inbox when `STORAGE_BUCKET` is configured
- PWA manifest/service worker/Home Screen install support

## Architecture

`iPhone PWA -> Cloud Run -> selected AI provider -> Google Cloud Storage inbox`

`ai.mjs` is the server-only provider boundary. Both adapters accept the same capture payload and return the same validated category/title/context/tags/confidence/destination_hint/extracted fields. The browser only calls `/api/analyze`; it never receives a provider API key or calls a model API directly. Gemini uses the [Generate Content API](https://ai.google.dev/api/generate-content), and OpenAI uses the [Responses API](https://developers.openai.com/api/reference/resources/responses/methods/create). No SDK or frontend change is required to switch providers.

The default model is `gemini-3.6-flash`, a [documented multimodal Flash model](https://ai.google.dev/gemini-api/docs/models). Override it with `GEMINI_MODEL` if needed. Model availability and quota must be verified with the deployment's Gemini key.

Provider requests have a 45-second timeout. Missing keys, unavailable providers, and invalid output produce editable local suggestions with a warning. There is **no automatic failover to another AI provider**. Upstream response bodies and keys are excluded from client warnings and analysis logs.

The GCS inbox is intentionally the durable capture layer for Rev 1. The next routing step can move/copy captures into HunterHomePhone Google Drive, myApron, Fleet, or work destinations based on the saved metadata without changing the capture UI.

## Local development
Requires current Node.js with built-in `fetch`.

```bash
PORT=3000 node server.mjs
```

Without Google Cloud environment variables, saves go to the local `data/` folder for development.

Server environment variables:
- `AI_PROVIDER` â€” `gemini` (default) or `openai`; invalid values fail startup
- `GEMINI_API_KEY` â€” required for real Gemini analysis
- `GEMINI_MODEL` â€” defaults to `gemini-3.6-flash`
- `OPENAI_API_KEY` â€” only used when `AI_PROVIDER=openai`
- `OPENAI_MODEL` â€” defaults to `gpt-5.6-luna`
- `CAPTURE_ACCESS_KEY` â€” family access code
- `STORAGE_BUCKET` â€” GCS bucket used in Cloud Run

Set keys through the server environment for local development. Never put them in `public/`, frontend storage, Docker build arguments, or source control. The Docker build excludes `.env` files.

Run `npm test` for provider contract, error redaction, timeout, authentication, and HTTP integration checks. These use synthetic data and mocked provider calls; no API key or paid model request is needed.

## Cloud Run
The repo includes a `Dockerfile` and `cloudbuild.yaml` for Cloud Build -> Artifact Registry -> Cloud Run.

Recommended Google Cloud resources:
1. Artifact Registry Docker repository named `smart-capturer` in `us-west1`.
2. Storage bucket named `<PROJECT_ID>-smart-capturer`.
3. Service account `smart-capturer@<PROJECT_ID>.iam.gserviceaccount.com` with permission to write objects to that bucket.
4. Secret Manager secrets `smart-capturer-gemini` and `smart-capturer-family-key`, with the Cloud Run service account granted `roles/secretmanager.secretAccessor` on those individual secrets. Keep `smart-capturer-openai` for an optional future switch.
5. Cloud Build trigger connected to the GitHub repo, using `cloudbuild.yaml`.

The service itself is deployed as publicly reachable HTTPS, but `/api/analyze` and `/api/save` require the family access code. The access code is remembered locally on each iPhone.

### Gemini deployment prerequisites

Before deploying this version:

1. Enable `generativelanguage.googleapis.com` in the key's Google Cloud project.
2. Create or select a server API key restricted to the Generative Language API. Store its value directly in Secret Manager as `smart-capturer-gemini`, version `1`; do not put the value in a command, chat, build substitution, or repository file.
3. Grant the existing runtime service account access to that secret. This is a new secret permission and must be approved before applying it.
4. Run Cloud Build from the updated source. Tests run before the image is built or deployed. The default substitutions select Gemini and inject `GEMINI_API_KEY` from the secret into Cloud Run at runtime. No key value is passed to Cloud Build. `_AI_KEY_VERSION` pins version `1`; change this to the approved numeric version when rotating the key.
5. Verify `/api/health` reports `ai_provider: "gemini"` and `ai: true`, then send an authenticated synthetic `/api/analyze` request and verify `source: "gemini"`. The health check confirms configuration only, not model access or quota. A fallback response is not a successful live AI test.

The build uses `--update-env-vars` and `--update-secrets` to preserve other runtime settings. Existing OpenAI secret configuration may remain mounted, but the Gemini adapter does not read or use it.

### Switch to OpenAI later

Keep the same application image and routes. Set `AI_PROVIDER=openai`, set `OPENAI_MODEL`, and map `OPENAI_API_KEY` to an approved version of `smart-capturer-openai` in Cloud Run. A future Cloud Build deploy must use matching substitutions or it will restore the Gemini defaults:

```text
_AI_PROVIDER=openai
_AI_KEY_ENV=OPENAI_API_KEY
_AI_KEY_SECRET=smart-capturer-openai
_AI_KEY_VERSION=<approved numeric version>
_OPENAI_MODEL=gpt-5.6-luna
```

Verify the selected model is available to the OpenAI account and check `source: "openai"` with an authenticated synthetic analysis after switching.

## iPhone install
Open the deployed HTTPS URL in Safari, then **Share -> Add to Home Screen**. It launches standalone as **Smart Capturer**.
