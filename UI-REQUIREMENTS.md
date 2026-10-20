# Mock Server — UI Requirements

> This document defines **what** the UI must do, not how it is laid out. Layout, hierarchy, spacing and visual styling are left to the designer, who should choose whatever best serves the workflow below.

## 1. Purpose
A tool for developers and QA to control what a single mock API endpoint returns. A user composes a response (method, status code, JSON body), **deploys** it, and any client calling the endpoint immediately receives it. Frequently used responses are saved as **samples** and redeployed quickly.

## 2. Users & core workflow
- Developers and QA testers simulating backend scenarios: success, validation errors, auth failures, outages.
- Used alongside an app under test; the loop is short and repetitive: **pick or edit a scenario → deploy → test the client → repeat**. The UI should make this loop fast.
- Must work on desktop and phone.

## 3. Access (login)
- The whole app is behind a PIN. The mock endpoint itself stays public.
- The user enters the PIN and unlocks. It is masked, and offers a numeric keypad on mobile.
- **Wrong PIN:** tell the user how many attempts remain.
- **Locked out** after 5 wrong attempts from the same machine/IP: block unlocking for 60 seconds and show a live countdown; unlocking becomes available again automatically.
- **Success:** the user goes to the app and stays signed in for 7 days.

## 4. Features

### 4.0 Endpoints
- There can be up to **3 endpoints**, each served at its own path (`https://host/<name>/…`). Each has its own live response and its own samples, so different teams can work independently.
- Show all endpoints and which one is being edited; each shows its live method and status at a glance. Switching endpoints is quick.
- **Create:** the user names a new endpoint (lowercase letters, digits, dashes; `api` and `login` are reserved). Show how many of the 3 are used; when all 3 are used, creating is unavailable and the UI says why.
- **Delete:** removes the endpoint with its live response and samples, after confirmation. The last remaining endpoint can't be deleted.
- Switching away from an endpoint with undeployed edits asks before discarding them.
- The selected endpoint is reflected in the page URL (`#name`) so a team can bookmark theirs.
- The original endpoint is `/mock`, so existing clients keep working.

### 4.1 Endpoint URL
- Show the full URL of the selected endpoint.
- Let the user copy it in one action, and confirm that it was copied.

### 4.2 Compose a response
- **Method:** ANY (default), GET, POST, PUT, PATCH or DELETE. ANY answers every method; otherwise other methods get `405`.
- **Status code:** 200–599, with one-click shortcuts for common codes (200, 201, 400, 401, 403, 404, 500, 503).
- **Body:** a JSON editor with line numbers, large enough for realistic payloads and resizable by the user. Long payloads scroll inside the editor (line numbers stay aligned); they never stretch the page. Empty means no body.
- **Format:** pretty-print the JSON. Invalid JSON shows a clear error and changes nothing.

### 4.3 Deploy
- **Deploy** is the primary action of the app and must be unmistakable: visually distinct from every other action and impossible to confuse with saving or deleting.
- The user must be able to see when their edits are **not deployed yet**, and that indicator must clear once they are.
- **Flow:**
  1. Validate (status range, JSON). On error, show it and deploy nothing.
  2. Show a **deploying state lasting about 2 seconds**, with visible progress and step labels (e.g. *Validating… → Deploying… → Going live…*). Deploying cannot be triggered again during this time.
  3. When done, update the live view, test the endpoint automatically, and confirm success.
  4. On failure, reset the deploying state and show the error.

> The real save is instant. The 2-second sequence is deliberate UX, so deploying feels like a considered, confirmed action.

### 4.4 Live response
- Always show what the endpoint is **currently serving**: method, status and body.
- **Test endpoint:** call the real endpoint (ANY is tested as GET), show the raw result, and give a clear pass/fail verdict on whether it matches what's live.

### 4.5 Samples
- Save the current response under a name. Saving with an existing name overwrites it.
- List all samples, showing each one's method, status and name; long names stay readable (for example, the full name on hover).
- For each sample:
  - **Load** it into the editor without deploying.
  - **Deploy** it directly, running the same deploy flow as 4.3.
  - **Delete** it, after confirmation.
- Show a helpful empty state when there are no samples.

### 4.5a Request log
- Each endpoint keeps its **latest 100 requests**; older ones are dropped automatically.
- For each request show: time, method, path (with query), the status that was served (including `405` for a wrong method), client IP and country, and client type (from the user agent).
- Expanding a request shows its headers and body (JSON pretty-printed; bodies over 4 KB are cut, with the original size shown).
- Credentials are never shown: `Authorization`, `Cookie`, `Proxy-Authorization` and `X-API-Key` values are redacted.
- The log refreshes automatically (can be turned off) and highlights new requests; there is a manual refresh and a **Clear** (with confirmation).
- Empty state tells the user which URL to call.

### 4.6 Feedback
- Every action gets brief feedback (saved, formatted, copied, deployed, deleted).
- Errors are clearly distinguishable from information.

### 4.7 Footer
Every screen ends with: **Built with ❤️ by Niaz**

## 5. Quality requirements
- Dark theme by default, with a toggle to switch to light; the choice is remembered per browser.
- Accessible: labelled inputs, full keyboard use, visible focus, errors announced to screen readers, and colour never the only signal.
- Animations respect `prefers-reduced-motion`.
- Sample names and other user-entered text are always rendered as plain text, never as HTML.

## 6. Out of scope
Multiple endpoints, custom headers, response delay, request logs, user accounts, non-JSON bodies.
