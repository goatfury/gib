# Legacy promotion mapping preparation

`tools/promotions-legacy-map.mjs` provides the pure `mapLegacyBook({ sheets, registry })` utility. It prepares source candidates for individual review. It does not migrate records, generate student IDs, create promotion events, or write to any workbook. There are no network calls. The existing 20 Promotion History entries and 9 Students records remain untouched; this work performs no live or TEST writes.

## Inputs and preservation

`sheets` supplies the six legacy tabs as native Google Sheets `CellData` matrices. Keep their typed raw cell values, displayed values, headers, and private source references together. Preserve blanks, repeated or unlabeled columns, notes, and orphan annotations rather than dropping them or inventing column meanings. Treat private source references as internal mapping evidence, not public output.

The block parser handles the belt tabs and all four embedded layouts in Former student. Repeated headers define separate historical blocks. A name appearing in two blocks is evidence to reconcile, not permission to merge people. An annotation without a student row remains source evidence needing attribution.

```js
import { mapLegacyBook } from './tools/promotions-legacy-map.mjs';

const mapping = mapLegacyBook({
  sheets: nativeSheets,
  registry: reviewedRegistry,
});
```

This example runs from the repository root with already supplied in-memory inputs. It neither fetches a workbook nor saves its result.

## Identity and source movement

Registry entries explicitly contain `{ studentId, distinguishingLabel, sourceFingerprint, sourceRef }`. Only a reviewed registry entry supplies an assigned student identity. Keep the distinguishing label visible when names repeat; never resolve identity by name alone.

The content fingerprint excludes row position. A uniquely matching source record can therefore move while retaining its explicitly assigned student ID, and its new location can be reported for reconciliation. A changed fingerprint or duplicate fingerprint requires individual reconciliation. Do not select the first duplicate, silently replace a registry association, or manufacture a student ID.

Content fingerprints are comparison evidence, not durable student IDs under content edits. Only the explicit registry ID represents the enduring student identity. Source references identify the observed location and should travel with the preserved source evidence.

## Rank and date interpretation

- An explicit numeric zero remains zero. Blank, `?`, and an ambiguous `Belt` entry remain unknown; they must not become zero through numeric conversion.
- A Black Belt value in unlabeled column B with an empty labeled rank column D is unresolved. Degree semantics apply only where the labeled D value is unambiguous; tab placement alone does not establish a rank.
- Former student blocks represent archived history. They do not establish an inferred current belt or authorize a return to active status.
- Preserve native dates and literal date text distinctly. Blank, `?`, `Transplant`, and `Early 2014` retain their original meaning and uncertainty; do not turn them into invented exact award dates.

An unresolved source record does not block other candidates. A later decision about one student's current rank can use the specific, audited rank-confirmation path. A complete audit of every historical entry is not a prerequisite for that individual confirmation. Mapping alone supplies neither confirmation nor a promotion event.

## Relationship to the running promotion tool

In the current TEST tool, Promotion History is authoritative and Students is its current derived view, updated on confirmed writes or reconciliation. Workbook views must stay current without silently disagreeing. This mapping preparation preserves the six legacy tabs exactly, including their native values and unknowns.

The proposed production mapping treats those retained belt tabs as historical source material, distinct from the current Students view. That is a proposal for explicit release review, not a permanent policy already applied to the live workbook. Any LIVE view labels, formulas, migration, or tab changes require later explicit release approval. No production tab is rewritten here.

Future instructor entry should distinguish instructor credit, the person recording the entry, and device provenance. Authorizing a device must not silently identify that device as the instructor. Keep the award date and its uncertainty separate from when an entry was recorded. This mapping preparation makes no authentication or device-authorization changes.
