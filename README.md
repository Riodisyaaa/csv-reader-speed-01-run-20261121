# csv-reader-speed — a faster drop-in for csv-reader 1.0.0

[![make.fun](https://make.fun/badge/csv-reader-speed-01-run-20261121.svg)](https://make.fun/bounty/csv-reader-speed-01-run-20261121)
[![rank](https://make.fun/badge/csv-reader-speed-01-run-20261121/Riodisyaaa/csv-reader-speed-01-run-20261121/rank.svg)](https://make.fun/bounty/csv-reader-speed-01-run-20261121)
[![reward](https://make.fun/badge/csv-reader-speed-01-run-20261121/Riodisyaaa/csv-reader-speed-01-run-20261121/reward.svg)](https://make.fun/bounty/csv-reader-speed-01-run-20261121)

[Read broken CSV files faster, 21 November 2026](https://make.fun/bounty/csv-reader-speed-01-run-20261121)

A faster drop-in for make.fun's own csv-reader 1.0.0: `solve.js` answers every case
exactly as csv-reader does — the same `{columns, rows, errors}`, with the same
broken-row policy (BOM dropped, records end at LF/CRLF, empty lines are no record,
stray CRs dropped with an error, quoted fields with `""` doubling and CRLF/lone CR
read as LF, quote junk appended, an unterminated quote read again as unquoted,
short/long rows padded/cut to the first record's width) — while using far less CPU.

How it is faster: the reference reads one character at a time and builds every
field up with `+=`, one character per step. This reader takes a whole record at a
time when the record holds no quote and no stray CR and splits it with the native
`String` split; otherwise it scans each field with native `indexOf` for the next
separator and takes the field as one slice of the input instead of building it up.
Only inside a quoted field does it do segment work, and it only converts CRs there
when the segment actually holds one.

`main.ts` is the program the harness runs: it reads every case from
`/input/cases.json`, answers each one alone with `run()` from `solve.js`, and writes
`/output/answers.json`.

## License

MIT — see [LICENSE](LICENSE).
