# Security policy

## Supported versions

Only the latest release published on the Chrome Web Store and Firefox Add-ons receives security
fixes.

## Reporting a vulnerability

Please **do not open a public issue** for security problems. Use GitHub's private reporting:
**Security → Report a vulnerability** on
<https://github.com/srikarthickeyanganapathy/playerstreamextension>.

Include the browser and version, the Velostream version, steps to reproduce and the impact. You
should get a first response within 7 days. Please give us a reasonable time to fix the issue before
disclosing it.

## Scope

Particularly relevant:

- a web page making the extension fetch something the page itself could not fetch
  (the page-identity proxy must stay limited to what the page can already do);
- a page reading or controlling the player iframe, settings or history;
- injection through stream titles, subtitle text or URLs rendered in the UI;
- anything that sends user data off the device.

Out of scope: DRM circumvention requests, and site-specific playback failures (open a normal
issue).
