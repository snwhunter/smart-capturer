# Smart Capturer — Revision 5

iPhone-first PWA for rapidly capturing **images, links, and data** into personal and work inboxes. Photo capture immediately returns control to the camera while upload and optional recognition continue in a resumable queue.

## Rev 5
- Rapid `capture -> use -> capture` photo loop; upload and AI never block the next capture
- IndexedDB-backed upload queue that resumes when the app is reopened
- Thumbnail activity log with upload, recognition, workflow, and destination status
- `/capture` personal URL and `/work` work URL using separate server-controlled Drive folders
- Metadata sidecars that can be updated by this app or a later folder-processing AI
- Authenticated `GET`/`PATCH /api/captures/<capture-id>?scope=personal|work` status API
- URL-preloaded context for tracker integrations, including an Andrew's Homework assignment shortcut
- Immediate queue-and-log capture for images, links, and data
- Backend link/data processing with retryable status updates
- Clickable capture records with server-validated editing

## Existing capabilities
- iPhone camera capture (`capture="environment"`)
- Multiple-image selection
- Link and free-form data capture
- Gemini image/text context analysis by default, with an optional OpenAI adapter
- Editable category, title, context, tags, and destination
- Family access code (`CAPTURE_ACCESS_KEY`)
- Google Drive `ToBeSorted` inbox when Drive OAuth is configured, with Google Cloud Storage fallback
- PWA manifest/service worker/Home Screen install support

## Architecture

`iPhone PWA -> local resumable queue -> Cloud Run -> personal/work ToBeSorted -> optional AI classification`

`ai.mjs` is the server-only provider boundary. Both adapters accept the same capture payload and return the same validated category/title/context/tags/confidence/destination_hint/extracted fields. The browser only calls `/api/analyze`; it never receives a provider API key or calls a model API directly. Gemini uses the [Generate Content API](https://ai.google.dev/api/generate-content), and OpenAI uses the [Responses API](https://developers.openai.com/api/reference/resources/responses/methods/create). No SDK or frontend change is required to switch providers.

The default model is `gemini-3.6-flash`, a [documented multimodal Flash model](https://ai.google.dev/gemini-api/docs/models). Override it with `GEMINI_MODEL` if needed. Model availability and quota must be verified with the deployment's Gemini key.

Provider requests have a 45-second timeout. Missing keys, unavailable providers, and invalid output produce editable local suggestions with a warning. There is **no automatic failover to another AI provider**. Upstream response bodies and keys are excluded from client warnings and analysis logs.

The capture path enqueues each image immediately, shows its thumbnail, and makes the camera available for the next shot. Two background workers upload queued images while the app remains active; unfinished jobs remain in IndexedDB and resume the next time that personal/work URL is opened. Each capture is accompanied by a JSON metadata sidecar. The UI polls that record, so an external sorter can update recognition status and final destination either through the authenticated status API or by updating the sidecar. AI failure never prevents an image from reaching `ToBeSorted`. When Drive OAuth is not configured, the existing GCS inbox remains the fallback.

Links and free-form data use the same fast path: Add immediately queues and saves the raw item, adds it to the capture log, and clears the input for the next item. The browser then keeps a backend processing request open without blocking the capture UI. Failed processing requests remain queued with bounded retry delays. When AI is disabled, the record is marked `waiting_for_ai` so a later backend or folder-processing AI can update it.

Every saved log entry links to `/record/<capture-id>?scope=personal|work`. The record page displays the raw item, classification, context, tags, destination, integration identity, and processing/review status. `PUT /api/captures/<capture-id>` accepts editable record fields, validates types, lengths, tags, required fields, and HTTP(S) link syntax on the server, then marks successful edits as validated. Changing raw link/data content triggers backend reprocessing.

## Preloaded capture context

Any tracker can open Smart Capturer with context already attached. A prominent warning-colored banner names the active context, explains that every photo will be attached to it, and repeats the context in the camera button. The context is copied into every image queued during that session, including retries. Preloaded values take priority over later AI guesses so the external record association is retained.

Andrew's Homework Tracker shortcut:

```text
/capture?assignment=<URL-encoded assignment name>&assignment_id=<stable assignment ID>
```

This sets `category=Homework`, `source=AndrewsHW Tracker`, and stores both `assignment_name` and `external_ref` in the capture metadata. The assignment ID is optional but strongly recommended for matching captures back to the tracker even if an assignment is renamed.

Generic integration parameters are `context`, `title`, `category`, `tags` (comma-separated), `source`, and `ref`. For example:

```text
/work?context=Panel%207&category=Work%20Photo&source=Job%20Tracker&ref=job-9&tags=plc,wiring
```

## Local development
Requires current Node.js with built-in `fetch`.

```bash
PORT=3000 node server.mjs
```

Without Google Cloud environment variables, saves go to the local `data/` folder for development.

Server environment variables:
- `AI_ENABLED` — set to `false` to use immediate local suggestions while keeping the selected provider configuration
- `AI_PROVIDER` — `gemini` (default) or `openai`; invalid values fail startup
- `GEMINI_API_KEY` — required for real Gemini analysis
- `GEMINI_MODEL` — defaults to `gemini-3.6-flash`
- `OPENAI_API_KEY` — only used when `AI_PROVIDER=openai`
- `OPENAI_MODEL` — defaults to `gpt-5.6-luna`
- `CAPTURE_ACCESS_KEY` — family access code
- `STORAGE_BUCKET` — GCS bucket used in Cloud Run
- `DRIVE_FOLDER_ID` — destination folder; configured as the shared `ToBeSorted` folder
- `WORK_DRIVE_FOLDER_ID` — separate work `ToBeSorted` folder used by the `/work` URL
- `GOOGLE_DRIVE_CREDENTIALS_JSON` — server-only JSON containing `client_id`, `client_secret`, and `refresh_token`

Set keys through the server environment for local development. Never put them in `public/`, frontend storage, Docker build arguments, or source control. The Docker build excludes `.env` files.

Run `npm test` for provider contract, error redaction, timeout, authentication, and HTTP integration checks. These use synthetic data and mocked provider calls; no API key or paid model request is needed.

## Cloud Run
The repo includes a `Dockerfile` and `cloudbuild.yaml` for Cloud Build -> Artifact Registry -> Cloud Run.

Recommended Google Cloud resources:
1. Artifact Registry Docker repository named `smart-capturer` in `us-west1`.
2. Storage bucket named `<PROJECT_ID>-smart-capturer`.
3. Service account `smart-capturer@<PROJECT_ID>.iam.gserviceaccount.com` with permission to write objects to that bucket.
4. Secret Manager secrets `smart-capturer-drive-oauth`, `smart-capturer-gemini`, and `smart-capturer-family-key`, with the Cloud Run service account granted `roles/secretmanager.secretAccessor` on those individual secrets. Keep `smart-capturer-openai` for an optional future switch.
5. Cloud Build trigger connected to the GitHub repo, using `cloudbuild.yaml`.

The service itself is deployed as publicly reachable HTTPS, but `/api/analyze` and `/api/save` require the family access code. The access code is remembered locally on each iPhone.

### Gemini deployment prerequisites

Before deploying this version:

1. Enable `generativelanguage.googleapis.com` in the key's Google Cloud project.
2. Create or select a server API key restricted to the Generative Language API. Store its value directly in Secret Manager as `smart-capturer-gemini`, version `1`; do not put the value in a command, chat, build substitution, or repository file.
3. Grant the existing runtime service account access to that secret. This is a new secret permission and must be approved before applying it.
4. Run Cloud Build from the updated source. Tests run before the image is built or deployed. The default substitutions select Gemini and inject `GEMINI_API_KEY` from the secret into Cloud Run at runtime. No key value is passed to Cloud Build. `_AI_KEY_VERSION` pins version `1`; change this to the approved numeric version when rotating the key. `_AI_ENABLED` defaults to `false` so depleted quota cannot delay capture; set it to `true` after a live quota check succeeds.
5. Verify `/api/health` reports `ai_provider: "gemini"` and `ai: true`, then send an authenticated synthetic `/api/analyze` request and verify `source: "gemini"`. The health check confirms configuration only, not model access or quota. A fallback response is not a successful live AI test.

The build uses `--update-env-vars` and `--update-secrets` to preserve other runtime settings. Existing OpenAI secret configuration may remain mounted, but the Gemini adapter does not read or use it.

### Google Drive deployment prerequisites

Enable the Google Drive API, create an OAuth client, and authorize the automation account with the `drive.file` scope and offline access. Store the resulting `client_id`, `client_secret`, and `refresh_token` JSON as version `1` of `smart-capturer-drive-oauth`. Supply `_DRIVE_FOLDER_ID` and `_WORK_DRIVE_FOLDER_ID` at build submission time. Verify a synthetic image and its metadata sidecar appear in each `ToBeSorted` folder before relying on the workflow.

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
