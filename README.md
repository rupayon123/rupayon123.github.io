# GTA Free STEM public website

Free public GitHub Pages hosting for [GTA Free STEM](https://rupayon123.github.io/).

The application and verified source data remain in [gta-free-stem-opportunities](https://github.com/rupayon123/gta-free-stem-opportunities).

The workflow builds public source main on a standard free GitHub-hosted Ubuntu runner and publishes a static website. It checks every six hours, skips unchanged source commits, and can be dispatched manually. It uses no paid runner, billing API, external hosting token or third-party account. Temporary publication artifacts are removed after completed deployment; failed uploads expire after one day. Publication rejects outputs over 800 MB or individual files over 90 MB, below GitHub Pages limits.

The separate source refresh workflow continues updating the original public native app feed. This repository does not run the collector or alter native feed URLs.
