# KB search eval — operationkit-queries.json

- Vault copy: 694 markdown files; model `local:Xenova/all-MiniLM-L6-v2:384`
- Backfill: 694 files → 7094 chunks in **290.7 s** (model load 509 ms, 0 failed); status `done`
- Re-run (resume / nothing changed): 694 skipped, 0 embedded in 0.04 s
- DB size: 0.04 MB → 20.06 MB (**+20.02 MB**, 2959 bytes/chunk)

| mode | recall@5 | hit@5 | MRR@5 | avg latency |
|---|---|---|---|---|
| keyword | **44.7%** | 11/22 | 0.409 | 10 ms |
| hybrid | **79.5%** | 18/22 | 0.632 | 19 ms |
| semantic | **61.0%** | 16/22 | 0.543 | 10 ms |

| kind | n | keyword recall@5 | hybrid recall@5 | semantic recall@5 |
|---|---|---|---|---|
| paraphrase | 17 | 46.1% | 73.5% | 61.3% |
| exact | 5 | 40.0% | 100.0% | 60.0% |

| id | query | keyword | hybrid | semantic |
|---|---|---|---|---|
| p01 | server reboot wiped features that only existed as uncommitted edits | 33.3% | 100.0% | 66.7% |
| p02 | sessions recorded as using no tokens after a backend restart | 0.0% | 100.0% | 0.0% |
| p03 | throwaway copy of the app for screenshots killed a running worker | 0.0% | 100.0% | 0.0% |
| p04 | the automated code reviewer just agrees with the author instead of checking the work | 0.0% | 0.0% | 0.0% |
| p05 | where do agent credentials really come from, Doppler or our own encrypted store | 0.0% | 100.0% | 100.0% |
| p06 | minimum font size and how greyed-out buttons should look | 100.0% | 100.0% | 100.0% |
| p07 | reopening a finished card should continue the same conversation instead of starting over | 100.0% | 100.0% | 100.0% |
| p08 | background summarization must not fall back to the paid API when the local model server is down | 100.0% | 100.0% | 100.0% |
| p09 | new chat bot name clashes with the CTO executive persona | 100.0% | 100.0% | 100.0% |
| p10 | pre-launch page that collects sign-ups from interested people | 100.0% | 100.0% | 100.0% |
| p11 | stop hardcoding the default Claude model and manage the list from a database table | 50.0% | 100.0% | 50.0% |
| p12 | status endpoint said everything was fine while alerts were not reaching anyone | 0.0% | 0.0% | 100.0% |
| p13 | tool connector registered for one Claude login is missing in the other logins | 0.0% | 0.0% | 0.0% |
| p14 | click-test the web app in a real browser without knowing the admin login | 100.0% | 100.0% | 100.0% |
| p15 | run each worker in its own sandbox container behind a feature flag | 0.0% | 50.0% | 25.0% |
| p16 | how to reward people who contribute to the open source project | 100.0% | 100.0% | 100.0% |
| p17 | bringing customers over from a rival product | 0.0% | 0.0% | 0.0% |
| e01 | obj 900510 | 0.0% | 100.0% | 50.0% |
| e02 | sweepStaleWorkingSessions | 100.0% | 100.0% | 50.0% |
| e03 | obj719092 | 0.0% | 100.0% | 0.0% |
| e04 | PR #442 session isolation | 0.0% | 100.0% | 100.0% |
| e05 | Fable 5 removal | 100.0% | 100.0% | 100.0% |
