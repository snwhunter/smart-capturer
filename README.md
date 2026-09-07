# Smart Capturer — Revision 1

iPhone-first PWA for capturing **images, links, and data**, attempting context automatically, letting the family correct it, and optionally reusing the same context for a batch.

## Rev 1
- iPhone camera capture (`capture="environment"`)
- Multiple-image selection
- Link and free-form data capture
- OpenAI image/text context attempt when `OPENAI_API_KEY` is configured
- Editable category, title, context, tags, and destination
- Shared-context batch mode
- Family access code (`CAPTURE_ACCESS_KEY`)
- Durable Google Cloud Storage inbox when `STORAGE_BUCKET` is configured
- PWA manifest/service worker/Home Screen install support

## Architecture

`iPhone PWA -> Cloud Run -> OpenAI context analysis -> Google Cloud Storage inbox`

The GCS inbox is intentionally the durable capture layer for Rev 1. The next routing step can move/copy captures into HunterHomePhone Google Drive, myApron, Fleet, or work destinations based on the saved metadata without changing the capture UI.

## Local development
Requires current Node.js with built-in `fetch`.

```bash
PORT=3000 node server.mjs
```

Without Google Cloud environment variables, saves go to the local `data/` folder for development.

Optional environment variables:
- `OPENAI_API_KEY` — enables real image/text context analysis
- `OPENAI_MODEL` — defaults to `gpt-5.6-luna`
- `CAPTURE_ACCESS_KEY` — family access code
- `STORAGE_BUCKET` — GCS bucket used in Cloud Run

## Cloud Run
The repo includes a `Dockerfile` and `cloudbuild.yaml` for Cloud Build -> Artifact Registry -> Cloud Run.

Recommended Google Cloud resources:
1. Artifact Registry Docker repository named `smart-capturer` in `us-west1`.
2. Storage bucket named `<PROJECT_ID>-smart-capturer`.
3. Service account `smart-capturer@<PROJECT_ID>.iam.gserviceaccount.com` with permission to write objects to that bucket.
4. Secret Manager secrets `smart-capturer-openai` and `smart-capturer-family-key`, with the Cloud Run service account allowed to access them.
5. Cloud Build trigger connected to the GitHub repo, using `cloudbuild.yaml`.

The service itself is deployed as publicly reachable HTTPS, but `/api/analyze` and `/api/save` require the family access code. The access code is remembered locally on each iPhone.

## iPhone install
Open the deployed HTTPS URL in Safari, then **Share -> Add to Home Screen**. It launches standalone as **Smart Capturer**.
