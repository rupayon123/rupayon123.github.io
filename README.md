# GTA Free STEM public website

Free public hosting for [GTA Free STEM](https://gta-free-stem.pages.dev/), with a GitHub Pages backup at https://rupayon123.github.io/.

The application and verified source data remain in [gta-free-stem-opportunities](https://github.com/rupayon123/gta-free-stem-opportunities).

The workflow builds public source main on a standard free GitHub-hosted Ubuntu runner and publishes a static website. It checks every six hours, skips unchanged source commits, and can be dispatched manually. It uses no paid runner or billing API. Temporary publication artifacts are removed after deployment attempts, including failed deployments; interrupted uploads expire after one day if runner cleanup cannot run. Publication rejects outputs over 800 MB, more than 20,000 files, or individual files over 25 MiB, within the free hosting limits.

The separate source refresh workflow continues updating the original public native app feed. This repository does not run the collector or alter native feed URLs.

The branded Cloudflare Pages deployment uses a Pages-only token stored in an encrypted repository Actions secret, exposed only to the publishing step. It activates no paid plan or billable runtime. The same reviewed build is then published to the GitHub Pages backup. Publication skips only when both hosts report the current source commit, so a partial publication can recover on the next run.

Every successful run verifies both public release manifests and the actual native feed bytes, including skipped builds. It records `last-verified-publication.json` when the source changes or on the first healthy check of a new UTC day. A stale host, wrong digest, wrong record count, oversized response or failed request cannot replace the retained receipt. This creates useful deployment history and ongoing repository activity; GitHub can otherwise disable a public repository's schedule after [60 inactive days](https://docs.github.com/en/actions/reference/workflows-and-actions/events-that-trigger-workflows#schedule).

The receipt uses the hosting repository's short-lived `GITHUB_TOKEN` with repository contents write permission, without a new account/token secret or paid job. Token-created commits [do not recursively trigger push workflows](https://docs.github.com/en/actions/how-tos/write-workflows/choose-when-workflows-run/trigger-a-workflow#triggering-a-workflow-from-a-workflow). A matching same-day receipt produces no extra commit. The script's failure-retention tests run before recording health; no receipt is a substitute for the build, source QA or platform release gates.
