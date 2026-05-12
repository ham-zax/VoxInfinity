# VoxInfinity

VoxInfinity is a pair of userscripts for long-form text-to-speech experiments.
It splits long text into smaller chunks, generates audio for each chunk, and
plays the generated clips through its own queue.

## Recommended mode

Use `VoxInfinity Direct API` first. It is the main script and is usually the
best option because it sends speech requests directly instead of clicking
through the page UI for every chunk.

Both scripts support the homepage widget. `VoxInfinity Direct API` has been
tested with the homepage widget only, and that is the recommended path for the
free/unlimited experiment: queueing chunks through the homepage widget session.

The platform playground is also supported and can produce better quality output,
but it follows the platform's normal account, quota, and free-credit limits.
Use the playground when quality matters more than the free/unlimited homepage
widget path.

The target voice website expects requests to come from an active page session.
Keep the TTS tab open and active while generating. If you want smoother playback
or need to leave the tab later, click `Pre-gen all` while the tab is active so
the queue is prepared first.

VoxInfinity works around the per-request character limit by splitting text into
chunks. It does not make the paid playground unlimited. The homepage widget is
the free/unlimited target for this experiment.

`VoxInfinity DOM Automation` also supports the homepage. It should work with
both the homepage and playground flows because it uses the page UI, but I only
tested it a little and did not find an obvious issue. Treat this whole project
as my experiment, not a polished product.

Use the main screenshot below to identify the platform name and confirm you are
on the intended TTS website/page before installing or troubleshooting.

<p>
  <img src="assets/image.png" alt="VoxInfinity running on the supported homepage TTS platform" width="100%">
</p>

<p>
  <img src="assets/direct-api.png" alt="VoxInfinity Direct API mode on the supported TTS playground" width="49%">
  <img src="assets/dom-automation.png" alt="VoxInfinity DOM Automation mode on the supported TTS playground" width="49%">
</p>

## What is included

- `scripts/vox-infinity-direct-api.user.js` - Direct API mode. Install this
  first. This is the homepage-widget-tested version.
- `scripts/vox-infinity-dom-automation.user.js` - DOM Automation mode. Use this
  lightly tested fallback if direct API mode cannot learn or send the speech
  request reliably. It supports the homepage too.
- `configure.py` - fills in the checked-in `TARGET_DOMAIN` and `TARGET_MODEL`
  placeholders before installation. These placeholders are intentional: the
  target website owner could patch against obvious public literals, so the repo
  keeps those values out of the checked-in userscripts until local setup.

## Install

1. Install a userscript manager such as Tampermonkey.
2. From the repository root, run:

   ```bash
   python3 configure.py
   ```

3. Open `scripts/vox-infinity-direct-api.user.js` in your browser and install
   it.
4. Open the target TTS page. The `VoxInfinity` button appears in the lower-right
   corner when the page is supported.

Do not install the scripts before running `configure.py`; the checked-in files
use placeholder match rules.

## Use

1. Open the target TTS page.
2. Click `VoxInfinity`.
3. Paste long text into the panel.
4. Click `Prepare` to split it into chunks.
5. Click `Start`.
6. Keep the tab active while the site accepts API/generation requests.
7. Optional but recommended for long text: click `Pre-gen all` first while the
   tab is active, then play the prepared queue.

## Notes

- Direct API mode sends chunks through the learned/default speech endpoint.
- DOM Automation mode clicks the page's normal generate flow and captures the
  returned audio.
- Direct API mode is tested with the homepage widget only.
- DOM Automation mode supports the homepage and should work with playground
  flows too, but it is not fully tested.
- Keep the tab visible while DOM Automation mode is generating; background tabs
  can delay browser automation and media capture.

## Disclaimer

This is an experimental research project. Use it only where you are allowed to
automate the target site, and respect the site's terms and usage limits.
