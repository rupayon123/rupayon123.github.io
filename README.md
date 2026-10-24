# GTA Free STEM public website

Free public hosting for [GTA Free STEM](https://gta-free-stem.pages.dev/), with a GitHub Pages backup at https://rupayon123.github.io/.

The application and verified source data remain in [gta-free-stem-opportunities](https://github.com/rupayon123/gta-free-stem-opportunities).

The workflow builds public source main on a standard free GitHub-hosted Ubuntu runner and publishes a static website. It checks every six hours, skips unchanged source commits, and can be dispatched manually. It uses no paid runner or billing API. Temporary publication artifacts are removed after completed deployment; failed uploads expire after one day. Publication rejects outputs over 800 MB, more than 20,000 files, or individual files over 25 MiB, within the free hosting limits.

The separate source refresh workflow continues updating the original public native app feed. This repository does not run the collector or alter native feed URLs.

The branded Cloudflare Pages deployment uses a Pages-only token stored in an encrypted repository Actions secret, exposed only to the publishing step. It activates no paid plan or billable runtime. The same reviewed build is then published to the GitHub Pages backup. Unchanged-source checks use the branded release manifest.
