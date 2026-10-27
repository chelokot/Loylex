# Work log · Telegram job 1648 · 2026-10-27

## Scope

Requested an open-ended study of the shortest beginnings distinguishing Russian root families, with whole-dictionary computation, root boundaries, word/segment lengths, inflection folding, and graphical delivery. Work is isolated in branch `research/russian-prefixes-1648`; the agent/gateway runtime and standing instructions are unchanged. Concurrent changes in the original checkout were preserved.

## Source review and decisions

- Inspected author descriptions, download formats, individual sample records, and checksums. `sources.json` pins the downloaded dictionary bytes; GitHub data URLs use immutable source commits except the separately checksummed release asset.
- Downloaded Universal Derivations v1.1 (68,432,626 bytes). Its MD5 matched repository metadata `bf05839a5324cce1f1665667247c9eb7`; extracted only the explicitly named Russian data, license, and attribution. The bundled Russian gzip has its own SHA-256 pin. No archive contents were executed.
- RuMorphs is not an exhaustive modern lexicon. Found absent common lemmas (including красный, стол), inconsistent allomorph segmentation, homonymous roots, and multiple-root words. Rejected a claim of a definitive result for “all modern Russian”. Two explicitly sourced missing example entries are recorded in the audit.
- Source root IDs include etymological groupings; applied a surface-boundary agreement gate to avoid automatically merging красн- into крас-. Separate alternative computations quantify dependence on modeling assumptions.
- Concrete normalization failure: word forms and comparative forms were assigned distinct families in raw inputs. Added known-dictionary normalization, retaining all known alternatives. For homonymous residual variants, added only uniquely compatible nest-based disambiguation. Remaining R labels explicitly preserve unresolved uncertainty; they are not certified semantic families.
- OpenCorpora direct HTTP access returned 403. Used the public pinned `pymorphy3-dicts-ru` wheel instead, in an isolated venv; only known analyses/paradigms are expanded. Dependencies are pinned with wheel SHA-256 hashes; no persistent service or runtime dependency was added.
- Saved a broad corpus dictionary and several independent model outputs, without treating a larger noisy source as better truth. Full source morpheme dictionaries with unclear licenses and row-level derived tables remain local/downloadable artifacts rather than being republished in Git.

## Computation and outputs

- 95,893 input spellings; 14,302 modeled groups after known-form normalization.
- 1,778,766 different generated/seed form spellings, 1,788,207 form-family records. Complete row exports, per-family summaries, witnesses, root boundaries, and aggregate metrics are saved.
- Trie algorithm for normal dictionaries; sorted-neighbour algorithm for the larger form set avoids large object-trie memory consumption. Processing stayed bounded and added no services or public listeners.
- Eight-page PDF, PNG overview, and offline searchable HTML. Graphics use Matplotlib 3.11.1 / NumPy 2.5.2; no generative graphics or external browser scripts.

## Validation

- Eight tests passed: full brute-force random comparison, independent trie/sorted comparison, family folding, end marker vs homography, красный/красивый separation, рук/руч and мрак/мрач alternations, водный/водить separation.
- Every aggregate distribution sum equals its solved count. Main solved + end-marker-only + homograph-unresolved counts equal the number of exported records.
- All pinned local inputs verified by the downloader; Python modules compiled successfully; `git diff --check` passed.
- Visually inspected the main PNG and an eight-page contact sheet: no clipped labels or overlapping panels observed.
- Executed the generated HTML JavaScript in a local DOM harness: full payload count, word search, highlighted root display, empty query result, family lookup, and absence of external scripts passed. Fixed a real case-folding error in family-ID search before delivery. A full browser rendering was not available; PDF/PNG were visually inspected directly.

## Recovery and persistence

The change consists of additive research files, pinned inert licensed input data, and aggregate artifacts. It does not affect running Loylex. It can be reproduced in the dedicated checkout; removing the research branch is unnecessary for runtime rollback. Raw dictionaries and row-level outputs are saved under this checkout's ignored data/artifact paths; source code and aggregates are committed and pushed to the authorized origin research branch. No main deployment is required for this research-only branch.
