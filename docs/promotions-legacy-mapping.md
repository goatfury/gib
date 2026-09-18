# Legacy promotion mapping preparation

`tools/promotions-legacy-map.mjs` provides the pure `mapLegacyBook({ sheets, registry, asOfDateNY })` utility. It prepares source candidates and evidence for review. It does not migrate records, generate student IDs, create promotion events, or write to any workbook. There are no network calls. Current workbook counts and post-import activity must come from a fresh private read, never from this document or historical import counts.

## Inputs and preservation

`sheets` supplies the six legacy tabs as native Google Sheets `CellData` matrices. Keep their typed raw cell values, displayed values, headers, and private source references together. Preserve blanks, repeated or unlabeled columns, notes, and orphan annotations rather than dropping them or inventing column meanings. Treat private source references as internal mapping evidence, not public output.

The block parser handles the five belt tabs and all five embedded layouts in Former student. Repeated headers define separate historical blocks. A name appearing in two blocks is evidence to reconcile, not permission to merge people. An annotation without a student row remains source evidence needing attribution.

```js
import { mapLegacyBook } from './tools/promotions-legacy-map.mjs';

const mapping = mapLegacyBook({
  sheets: nativeSheets,
  registry: reviewedRegistry,
  asOfDateNY: sourceCaptureDateNY,
});
```

This example runs from the repository root with already supplied in-memory inputs. It neither fetches a workbook nor saves its result.

## Identity and source movement

Registry entries explicitly contain `{ studentId, distinguishingLabel, sourceFingerprint, sourceRef }`. Only a reviewed registry entry supplies an assigned student identity. Keep the distinguishing label visible when names repeat; never resolve identity by name alone.

The documented Black layout has `Name` in A, an unlabeled column B, `Date` in C, and `Rank awarded` in D. It has two row variants: split names in A/B, and complete A names with the generic rank marker `Belt` in B. Join the trimmed A and surname parts only for the split-name variant. Never append a B rank marker (`Belt`, `Black Belt`, a labeled mark count, or `?`). This also applies to the recognized archived Black block. Other tabs retain the complete A value; B is a rank summary or other information and must never be appended. Original spelling, accents, punctuation, and untrimmed source values remain in `items`. `nameEvidence` identifies the source cells used. An uncertain rank cannot erase or block a source-supported full name.

The content fingerprint excludes row position. A uniquely matching source record can therefore move while retaining its explicitly assigned student ID, and its new location can be reported for reconciliation. A changed fingerprint or duplicate fingerprint requires individual reconciliation. Do not select the first duplicate, silently replace a registry association, or manufacture a student ID.

Content fingerprints are comparison evidence, not durable student IDs under content edits. Only the explicit registry ID represents the enduring student identity. Source references identify the observed location and should travel with the preserved source evidence.

The corrected display name and rank interpretation do not alter the original content fingerprint, so existing registry bindings survive this interpretation repair. The historical fingerprint intentionally excludes display formatting. A repair must therefore also verify the exact header row, typed values, displayed text, and number-format patterns used to interpret dates under the write lock. The fingerprint alone does not prove date precision.

## Rank and date interpretation

Current-belt award blocks are explicit. Read their labels individually; do not count occupied cells or scan into earlier belts.

| Layout | Summary | Current-belt awards | Earlier-belt history begins |
| --- | --- | --- | --- |
| Black | D; C dates an explicit D summary | E:H labeled marks; I labeled Black Belt | J |
| Brown | B | C:F labeled stripes; G labeled Belt | H |
| Purple | B | C:F labeled stripes; G labeled Belt | H |
| Blue | B | C:F labeled stripes; G labeled Belt | H |
| White | B | D:G labeled stripes; C is instructor | Beyond G is retained annotation |

A recognizable date in a labeled current-belt award column establishes the recorded mark even if the summary is blank or `?`. The column label supplies the count. For a synthetic example, E labeled `4 stripes` with a recorded date of March 1, 2024 and blank D establishes Black Belt, 4 degrees in the application's existing Black rank representation, recorded date `2024-03-01`. The source label remains preserved verbatim; this is an interpretation of this book, not an outside promotion rule. Repeated `4 stripes` labels starting at J belong to an earlier belt.

An explicit numeric or labeled summary remains usable when matching history is missing. A higher current-belt award than an explicit count summary, or contradictory exact-date ordering involving the selected current award, is a conflict requiring resolution. A generic `Belt` summary does not assert zero and cannot contradict a positive labeled stripe award. Date-order uncertainty confined to older, lower awards remains historical uncertainty and does not erase a clearly later current award. A source-supported full name remains available. A lower historical mark cannot date a higher summary rank.

An explicit numeric zero remains zero. Blank and `?` never become zero. A bare `Belt` summary remains uncertain without a supporting award in the labeled belt column; a supported base-belt award establishes zero recorded marks. Literal rank labels in their matching base-belt award column establish that rank without inventing a date. Arbitrary annotations such as `Transplant` or `joined ...` do not establish a dated promotion.

`currentRank.date` separates exact dates from missing, approximate, uncertain, annotated, conflicting, and invalid values. Native date serials and strict literal date forms can provide an exact day. A native serial displayed using a month/year-only number format remains month precision: its hidden day is not an award day. Approximate dates such as `Early 2014`, dates with `?`, two-digit literal years, and multiple dates in one cell retain their source text without an invented exact date. A dated `(Belt)` annotation explicitly identifies a belt award. A dated `(Transplant)` annotation may record arrival while already holding a rank: retain its exact source text, recover the supported rank, and leave the original promotion date uncertain. `asOfDateNY` is the explicit source-capture cutoff used to reject future historical dates. The repair or import date must never fill an old award date.

Former student blocks represent archived history. They preserve their recognized layout and source evidence but do not establish an inferred current belt or authorize a return to active status.

An unresolved source record does not block other candidates. A later decision about one student's current rank can use the specific, audited rank-confirmation path. A complete audit of every historical entry is not a prerequisite for that individual confirmation. Mapping alone supplies neither confirmation nor a promotion event.

## Relationship to the running promotion tool

Promotion History is authoritative and Students is its current derived view, updated on confirmed writes or reconciliation. Workbook views must stay current without silently disagreeing. This mapping preparation preserves the six legacy tabs exactly, including their native values and unknowns.

The completed import must not be restarted. Repairs are separate, privileged, audited history entries; ordinary instructor corrections cannot rename students or bulk-repair imported data. Each field proposal must bind to its existing registry identity, original baseline, source evidence, current revision, and last event. Recheck those conditions inside the commit lock. Independent name repairs may survive a later application promotion; historical baseline rank/date repairs must not reinterpret later increments or replace newer application activity.

Preserve original student, event, and request IDs and original event contents. A private comparison checks source-to-result meaning independently of the generated repair manifest. Deploy compatible readers before writing any new repair event. Rollback retains those readers and all later entries; it must never restore an old workbook snapshot over subsequent activity. Live repair requires separate approval of the bounded private manifest and release procedure.

Public tests contain only synthetic equivalents. `tests/promotions-legacy-map-repair.test.mjs` records independently transcribed expected layout answers, including the original split-name/blank-summary failure, before the mapper implementation. The original fingerprint is pinned in a fixture to verify compatibility. Real roster values, source comparisons, and proposed repair manifests stay outside the public repository and preview assets.

Future instructor entry should distinguish instructor credit, the person recording the entry, and device provenance. Authorizing a device must not silently identify that device as the instructor. Keep the award date and its uncertainty separate from when an entry was recorded. This mapping preparation makes no authentication or device-authorization changes.
