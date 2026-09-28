---
name: jev-status
description: Shows the state of the jev-hooks backend (host, model, fingerprint, latency, calibration profile) measured with one real decision. Use it for "is jev working?", "check the backend", "which calibration is it using?".
allowed-tools: Read
---

The `<jev-status>` block in the context was produced by a hook outside the sandbox. Report
it in a short table: host, model, fingerprint (first 12 characters), probability_status,
latency of the probe decision, the profile chosen and whether it is calibrated, the
configuration files in use, and any notes or warnings. If it holds an error, say in one
line what to check (the URL, the key, whether the backend is on, a proxy). If the block is
missing, the hook did not run: say so and stop. Do not try to reach the backend yourself:
the sandbox has neither the network nor the key.
