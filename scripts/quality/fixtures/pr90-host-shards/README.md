# Independent-host regression evidence

The two `.summary` files are byte-for-byte sanitized `summary.json` entries from [run 40545789572, attempt 1](https://github.com/bolsterdigital/mycel/actions/runs/40545789572/attempts/1). A separate extension preserves the original bytes through formatting. These are public synthetic corpus reports, without authenticated raw reports or private planning data.

`run.json` records the GitHub artifact ids, original archive digests, extracted summary SHA-256 hashes, head/merge ancestry and the source contract derived from the measured commit `e4c0880856cc06f04c20a83bfc752f310e9b6989`. Its source hashes cover the exact corpus, seed, matrix, workflow and lockfile bytes retrieved from that commit. The fixture loader verifies each summary hash before parsing it. The historical v3 corpus remains separate from current v4.

Both jobs used the same source-pinned container and tool versions but different GitHub kernels and host images. The existing runner suite reproduces their complete four-cell/twenty-sample batch in both orders, retains the original failed scores and individual host metadata, and rejects altered provenance, tools, artifacts or samples. A structurally complete failed measurement remains failed and blocks once enforcement applies.
