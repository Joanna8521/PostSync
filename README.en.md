**English** · [繁體中文](README.md) · [日本語](README.ja.md)

# ⚡ Post Sync — social post collector

An open-source Chrome extension. On **Facebook, Threads, X, Instagram or
LinkedIn**, when you scroll past a post worth keeping, one click puts it in
**your own Google Drive**, with optional sync to a Focus4ai knowledge base.

- **One Google Doc per post**, named `date_topic_author`, for example
  `20260813_write-your-questions-down-before-the-meeting_Wang`
- **Images embedded in the Doc**, not a URL that 404s within days
- **The permalink at the top of the document**, so you can go back for the comments
- **Capturing the same post twice asks you first**, with a link to the earlier copy
- **Least privilege**: the `drive.file` scope only, which reaches only the files
  this extension created. It cannot see anything else in your Drive.
- **Interface in English, 繁體中文 and 日本語**, following your browser's language

## How to use it

Two ways, both of them something you press:

**Right-click** (recommended): right-click a post and pick
**"⚡ Capture this post"**. You point at exactly the one you mean, with no
ambiguity. Right-clicking a comment still gives you the whole post rather than
that one comment. And when the floating button has not appeared, because of the
layout or a redesign, this route is still there.

**The floating button**: scroll to a post and **"⚡ Capture this"** floats in on
its right, while that post gets a pale violet outline so you can see which one a
click would take.

No keyboard shortcut is **bound by default**, so it will not fight one you
already use. If you want one, find Post Sync at
`chrome://extensions/shortcuts` and bind it yourself.

**Every capture is one you pressed.** There is no automatic collection and it
never scrolls the page for you. That would turn "a person reading" into
"automated scraping", and the account risk is not remotely the same.

### Three destinations, each independent

| | What it stores | Who it is for |
|---|---|---|
| **Google Drive** | One Doc per post, images embedded | People reading |
| **Focus4ai knowledge base** | Markdown, chunked and indexed on arrival | Retrieval |
| **persona-to-skill import file** | One JSON file you download | Reconstructing a method |

One of them failing does not affect the others. Using the knowledge base without
connecting Drive at all is fine.

What makes the third one different is also the reason it exists:
**no server, no authentication, the same behaviour in every browser.** The Drive
route goes through `chrome.identity`, which is Chrome-only. The Focus4ai route
needs a site and a set of settings. The import file just produces a file you
download, so it works for people who are not on Chrome, and it never touches
Google.

## Install

Three minutes. No development environment and no npm.

**Step 1: get the files** (either way works)

- **If you do not use git**: press the green **`Code` → `Download ZIP`** at the
  top of this repo. After unzipping, what you want is the **`extension`** folder
  inside.
- **If you do use git**:

  ```bash
  git clone https://github.com/Joanna8521/PostSync.git
  ```

Put it somewhere it can stay (Documents, for instance).
⚠️ After installing you **cannot delete or move it**: the extension runs
straight out of that folder.

**Step 2: load it into Chrome**

1. Type `chrome://extensions` in the address bar and **turn on "Developer mode"
   at the top right**.
2. Press **"Load unpacked"** at the top left, choose the **`extension`** folder
   (the level where you can see `manifest.json`) and press Select.
3. Once installed, a setup walkthrough opens by itself. Press
   **"Connect Google"** and authorise with your own account.
4. Open facebook.com, scroll to a post, and "⚡ Capture this" floats in on the right.

> The consent screen asks for exactly one permission: "See, edit, create and
> delete only the specific Google Drive files you use with this app". It cannot
> see anything else in your Drive.

### Common problems

- **You chose a folder and it says the manifest file is missing**
  Wrong level. Choose the level that has `manifest.json` in it.

- **Nothing happens / the floating button is not there**
  Go back to that tab and reload it with `Cmd+R` (`F5` on Windows). The
  extension needs the page to load again before it takes effect. Still nothing:
  click the extension icon and press **"Check the current tab"**, which tells you
  straight away how many posts it found.

- **Chrome reopens and offers to "disable developer mode extensions"**
  Press Cancel. This is Chrome's routine reminder about extensions not installed
  from the store.

The manifest contains a fixed `key` (a public key), so the extension ID is the
same for everyone who loads it: `mbckgmofgjkmfjofljddhgbhglfhjbom`. Sharing one
OAuth client only works because of that.

## Language

The interface follows your browser's language. Nothing to set.

| Browser language | What you get |
|---|---|
| Chinese (Traditional) | 繁體中文 |
| Japanese | 日本語 |
| English | English |
| anything else | English |

That covers the popup, the setup walkthrough, the floating button, the toasts,
the diagnostic output, the error messages, the Doc written to Drive and the
Markdown written to the knowledge base.

**The language of the pages you browse is a separate axis.** `adapters.js` and
`naming.js` match text that Facebook renders: the interaction bar, the
expand-and-collapse labels, relative timestamps. Those must recognise **every**
language at once rather than switching, because someone whose interface is in
Japanese may well be browsing Facebook in Chinese. Collapsing the two axes into
one breaks the extractor: the moment the interface switched to Japanese, the
whole "Like Comment Share" row of a Chinese Facebook would be swept into the
post body.

The interface strings live in `tools/messages.py`, with all three languages side
by side, and `tools/build_messages.py` generates the three
`extension/_locales/*/messages.json` from it. Writing those three files by hand
guarantees they drift, and the key that drifted shows up as the key itself under
one language, which only anyone who happens to open that page in that language
can see. `tools/run_tests.py` regenerates them and compares, so editing a
`messages.json` by hand does not quietly take effect.

Side-by-side has a second benefit: whether a translation is any good is something
you can only judge with all three in front of you. Read them one file at a time
and every line looks right.

## OAuth (only if you want your own client)

`manifest.json` already contains an OAuth client_id, so **pressing "Connect
Google" after installing just works** and there is nothing to set up. A Chrome
extension's OAuth client has no secret, the client_id is public information by
design, and putting it in an open-source project is standard practice.

If you want it entirely under your own control, so the data flow only ever
passes through your own GCP project, make your own and swap it in:

1. Create a project in the [Google Cloud
   Console](https://console.cloud.google.com/) and enable the **Google Drive
   API** and the **Google Docs API**:

   ```bash
   gcloud projects create <your-project-id> --name="Post Sync"
   gcloud services enable drive.googleapis.com docs.googleapis.com --project=<your-project-id>
   ```

2. "Google Auth Platform" → "Get started". Google moved the OAuth consent screen
   in here during 2025, so the menu is not where older tutorials put it:
   <https://console.cloud.google.com/auth/overview>
   Name the app whatever you like and choose "External" for the audience.

3. "Data access" → add the scope `.../auth/drive.file`. This is a
   **non-sensitive** scope, so it needs no Google review and has no 100-test-user
   cap.

4. "Audience" → **"Publish app"**. Left in testing, only the accounts on the list
   can use it, and the **refresh token expires after seven days**. The symptom is
   "it worked last week and today it just fails", and the error message says
   nothing at all about seven days.

5. "Clients" → "Create client" → application type **"Chrome extension"**, item ID
   `mbckgmofgjkmfjofljddhgbhglfhjbom`, then put the client ID you get into
   `oauth2.client_id` in `extension/manifest.json`.

> ⚠️ **Do not upload an app logo on the consent screen.** Uploading one puts the
> app into Google's **brand verification** process, which `drive.file` does not
> need at all. Days to weeks of waiting for one image is a bad trade. The store
> listing icon is a separate thing and unrelated to this.

The `key` in `manifest.json` determines the extension ID, and the item ID in the
Console has to match it, or authorisation fails all the way through **and the
error message does not tell you why**. After changing `key`, check with this:

```bash
python3 -c "import json,base64,hashlib;d=base64.b64decode(json.load(open('extension/manifest.json'))['key']);print(''.join(chr(ord('a')+int(c,16)) for c in hashlib.sha256(d).hexdigest()[:32]))"
```

## How images actually get into the Doc

`fbcdn` image URLs carry a time-limited token, so storing the URL stores
something that 404s within days. The Doc has to own its own copy, and there are
two layers to that:

1. **Hand the original URL to the Docs API's `insertInlineImage`.** Google fetches
   the image at the moment of insertion and stores it in the document, so the
   original URL expiring later does not matter. This is the fast path.
2. **If that is refused, download it instead.** The extension holds host
   permissions for these image CDNs, so it can carry a signed URL. It downloads,
   uploads to Drive, opens link access for a few seconds so Docs can fetch it,
   then revokes access and deletes the temporary file immediately.

Images are handled one at a time, so one failure does not take the others with
it. Only when both layers fail does it fall back to pasting URLs, and it then
says plainly in the Doc that those URLs usually stop working within days. It
never pretends it collected something.

## Focus4ai sync

With "Sync to a Focus4ai knowledge base" on in the popup, every capture also
writes Markdown into the knowledge base and **chunks and indexes it there and
then** (via `PUT /api/doc`, with no changes needed on the Focus4ai side).

- **URL**: the site root (the hosted site is `https://app.focus4ai.com`). Note
  that `focus4ai.com` is the marketing site and has no API. Filling that in is
  caught and explained.
- **Folder**: `00_inbox/post-sync` by default.
- **local_only**: **off** by default. Social posts are mostly public, and marking
  them keeps them out of retrieval, which makes collecting them pointless. Turn
  it on when you are collecting from a private group. (This is the opposite of
  Mesh Sync, which collects your own AI conversations and often has client names
  and quoted prices in them.)
- When the site is behind a login, the extension carries your login session from
  the same browser, so sign in before syncing. A redirect to the login page is
  reported as an error rather than reported as success.

## The persona-to-skill import file

[persona-to-skill](https://github.com/Joanna8521/persona-to-skill) reconstructs
the method behind what a person left in public, as something you can consult. It
**does not scrape social platforms itself**, and the reason is not technical but
about permission to take: the robots.txt of X, Instagram and LinkedIn says no, and
a tool that routes around that is, by itself, the reason it gets reported. So it
defines a shape instead, and anything that can produce that shape can feed it.

Post Sync happens to be exactly the route its own documentation describes: the
user presses it, it runs under their own credentials, and nothing is collected
automatically. Responsibility stays with the person doing it, which is where it
belongs.

With "Keep a persona-to-skill import file" on in the popup, the posts **you press
capture on** also keep a copy of their text locally (`chrome.storage.local`,
capped at 500 by default, oldest dropped when full). Pressing "Export the import
file" produces the JSON, which goes straight to your downloads folder without
passing through any server.

That switch is **off by default**. This extension's posture is that every capture
is one you pressed, and that posture does not survive quietly accumulating
content in the background.

The export deliberately **does not fill in** two fields:

| Field | Why not |
|---|---|
| `tier` (source tier, T0 to T3) | It depends on the form of publication. Which posts are the person's own words and which came from a social-media manager or a ghostwriter is not something a machine can see. |
| `subject` (who is being reconstructed) | It depends on who you want to reconstruct. |

Guessing a default would hand the gates on the other side a value that **looks
grounded and is wrong**, which is far more dangerous than no value at all: no
value gets stopped, a wrong one does not. So both are left for import time, and
the `note` in the file says so.

Someone else's words quoted inside a repost go in `embedded_other_party` rather
than being merged into `text`. Merged in, what someone else said would be
extracted as the subject's own method.

Images do not go into the import file, only `image_count`. The other side
reconstructs a method from text, and it explicitly refuses to produce anything
that trades on a likeness.

## Project layout

```
extension/
├── manifest.json        # MV3, with the fixed key (public key) and oauth2 settings
├── popup.html           # Collection switching, connection status, Focus4ai settings, log
├── onboarding.html      # The setup walkthrough that opens after installing
├── _locales/            # zh_TW / en / ja, generated from tools/messages.py
├── icons/
└── src/
    ├── i18n.js          # Fills _locales text into the HTML. No innerHTML anywhere.
    ├── adapters.js      # Per-platform anchors (the only place a platform redesign touches)
    ├── naming.js        # Filename topic (shared by the service worker and the tests)
    ├── extract.js       # DOM to data (pure functions, testable)
    ├── content.js       # Floating button, expanding the full text, toasts
    ├── background.js    # OAuth, Drive, image embedding, Focus4ai, deduplication
    ├── export_p2s.js    # To the persona-to-skill import file (pure functions, testable)
    ├── popup.js
    ├── onboarding.js
    └── toast.css
tests/
├── run.html             # The extraction layer: open it in a browser and it runs
└── live.html            # The floating button: a fake feed and fake chrome API, running content.js for real
tools/
├── messages.py          # All three languages side by side. The source of truth.
├── build_messages.py    # Generates _locales. --check compares instead of writing.
├── jsstrings.py         # Walks JS character by character, separating string literals from comments
├── run_tests.py         # Source scan, i18n checks, then the test page in headless Chrome
├── check_permissions.py # How well the manifest's permissions cover what the code does
└── check_i18n_render.js # Renders both pages in all three languages (needs Playwright)
```

- `key.pem` (repo root, not in git) is the private key, needed only to package a
  .crx. Loading unpacked does not need it.

## Tests

```bash
python3 tools/run_tests.py         # Green all the way through or it did not pass
python3 tools/check_permissions.py # Manifest permission coverage
```

You can also just open `tests/*.html` in a browser and look. If you do, remember
to add something like `?v=2` to the URL, or the browser serves the cached old
file and you see "I changed it and nothing happened".

**`tests/run.html`** is the extraction layer. What it pins down is the kind of
thing that **breaks with no screen telling you**:

- A comment taken for a post (on Facebook the **comment** is the `role="article"`;
  the post is `div[aria-labelledby]`)
- The whole feed taken for one enormous post
- Facebook's anti-scraping obfuscation characters collected into the body, the
  author and the filename
- An author name with "Verified account", "Follow" or "Shared with: Public" stuck to it
- Right-clicking a comment and getting that comment rather than the whole post
- An avatar taken for a content image
- A permalink carrying tracking parameters, so the same post fingerprints
  differently every time and deduplication stops working entirely
- A platform redesign emptying the body container, so it quietly collects nothing
- An author name or a timestamp becoming the filename, so a whole folder looks the same
- **Facebook serving different DOM to different people** (A/B tests and staged
  rollouts). Three post containers are known to be in use: `role="article"`,
  `div[aria-labelledby]` and `div[aria-posinset]`, each with its own fixture. On
  this platform, "it works for me" does not generalise to anyone else.
- The three-language interface: the `**bold**` markup renderer, and that a
  message containing HTML is shown as text rather than parsed into nodes
- The page-language matchers in Chinese, English and Japanese, plus eleven real
  first lines confirmed not to be mistaken for timestamps

**`tests/live.html`** is the floating button. A fake feed and a fake `chrome` API,
running `content.js` for real, with a panel in the bottom left that reports
whether the content script was injected, how many posts were found, the button's
`display`, `z-index` and coordinates, and whether it went off screen. When the
button does not appear, look at this page first: it tells you whether the problem
is the code or the environment.

**`python3 tools/check_permissions.py`** is permission coverage. Run it after
changing `manifest.json`.

A wrong match pattern produces **no error at all**: Chrome just quietly does not
inject the content script, or quietly blocks background's fetch, and the symptom
looks exactly like something else ("this platform does nothing", "images are not
coming through"). So this script implements Chrome's matching rules itself and
runs real URL shapes against them:

- Whether the content script's matches cover the URL shapes each platform really
  uses (Facebook's `/photo/?fbid=`, both the old and new Threads domains, X and
  twitter.com, and so on)
- Whether host_permissions covers the four image CDNs and three Google APIs
- And the other way round, whether anything is **over-requested**: declared but
  used by no code, which only slows down store review

## Known limits

- **No floating button on phones.** Neither iOS nor Android allows injecting UI
  into the Facebook app. Mobile would need a Safari Web Extension (possible, but
  it needs Xcode and a developer account) or an iOS Shortcut plus OCR, and the
  latter needs Focus4ai to offer a **token-authenticated** write API first: the
  current write relies on a browser session (`credentials: 'include'`), and a
  phone shortcut has no session.
- **Long posts on X may come through truncated.** X's "Show more" is a link, and
  pressing it navigates away, so the code does not press it. Truncated content
  beats being thrown off the page.
- **LinkedIn does not put the permalink in the DOM.** It is assembled from the
  activity urn on `data-id` / `data-urn`. LinkedIn also changes its layout more
  often than the others: the post container is `role="listitem"` now, and the old
  `.feed-shared-update-v2` is gone.
- **Instagram's post container has no semantic attribute at all** (no `role`, no
  `data-testid`, every class is `.html-div`), so it instead walks up from the
  permalink `a[href*="/p/"]` to the first ancestor that has both a `<time>` and an
  `<img>`. By meaning, not by appearance.
- **A platform redesign can throw the extraction off.** Every anchor is collected
  in `src/adapters.js`, so it is one file to change. When the body text cannot be
  found it says so on screen rather than quietly collecting an empty one.
- **Listing on the Chrome Web Store needs a justification.** Declaring a host
  permission like facebook.com draws a review question about why it is needed. To
  reduce that friction, this could move to `optional_host_permissions` plus
  `chrome.scripting.registerContentScripts` for dynamic registration, letting
  people turn on one platform at a time themselves.

## Privacy

- Capture is **always triggered by hand** (the floating button or a shortcut).
  Nothing is uploaded automatically.
- Data only goes to the user's own Google Drive and the Focus4ai site they
  specified. This extension has no server of its own.
- The persona-to-skill import file is off by default, and with it on the material
  only stays on the local machine. Whether it becomes a file is the user's own
  press, and no route sends it anywhere.
- Under the `drive.file` scope, the extension can only see and change the folder
  and documents it created itself.
- On the second image path, link access is opened briefly and revoked the moment
  insertion completes, along with deleting the temporary file.

## License

MIT
