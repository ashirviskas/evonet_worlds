# EVONET WORLDS
Run it [here](https://ashirviskas.github.io/evonet_worlds/poc.html)

Evonet Worlds is an evolution simulation. It started as a single HTML page PoC. 

End goal of the project: Many worlds running on different player machines, sharing portals to each other allowing to run tons of evolution experiments at once and increasing the available world size. Possibly a Vulkan implementation for a huge speed boost, distributed on Steam.

Early 2026
Initial html + js PoC experiments, showing that this may work as we have first multiplicators evolving naturally in ~4M world sim ticks. TPS: from ~500 to 5k depending on population size and computer specs, running in a browser.



## TODO

### Features
- [ ] Protein complexes, allowing to combine multiple proteins to create new functionality, allowing evolution landscape to explore it all
- [ ] Sun/Environment tuning to allow for a more complex environment
- [ ] Decode ramblings from IDEAS.md

### Architecture
- [ ] Rewrite for Vulkan. C++ or Rust. Possibly keep js implementation for faster iteration and experiments. Maybe even both cross-implementation compatible. 

Single-page evolution simulation. `poc.html` opens directly from `file://`.

## Whatever AI generated

## Editing

Source lives in `src/*.js` — one file per section of the original monolithic script. `poc.html` is **generated**; don't edit it directly.

```
poc.template.html   ← HTML + CSS shell with <!-- JS_BUNDLE --> marker
src/NN_name.js      ← JS sections, concatenated in lexicographic order
build.py            ← template + src/*.js → poc.html
poc.html            ← generated, committed
```

## Build

```
python3 build.py
```

Stdlib-only. Reads `src/*.js` in sorted order, joins them with `// ===== filename =====` separators, and injects into the template.

## How the JS is stitched

All `src/*.js` files run in the **same global scope** (single `<script>` tag, no modules). This is required because inline `onclick=` handlers in the HTML body reference functions by bare name (e.g. `librarySpawnFree(...)`, `editChromosome(...)`). A few functions are also explicitly set on `window.*` for that reason.

Practical consequences:

- Don't wrap file contents in IIFEs or add `export` — names must stay global.
- Load order matters: file `04_world.js` must come before anything that uses `world`, etc. The numeric prefixes exist purely to control that order.
- If you add a new section, pick a prefix that places it correctly in the load chain.

## Adding a new section

1. Create `src/NN_your_section.js` (pick NN to land in the right load order).
2. `python3 build.py`.
3. Open `poc.html` in a browser.

## Benchmark

Headless Node harness under `bench/`. Stubs DOM globals and loads only sim files (`01_*` through `18_*` plus `14b_lineage.js`) — no rendering. Runs `tick()` in a loop, wraps every phase function with `process.hrtime` accumulators, prints ticks/sec and a per-phase breakdown.

```
# default: 500 cells, 10k ticks, 1k warmup
node bench/run.js

# canonical sweep — pop200/500/2000 at 5k ticks, seeded reproducer at 50k ticks, 1k warmup.
# Write each run into its own file under bench/results/<change_name>/ so
# before/after pairs stay trivially diffable.
mkdir -p bench/results/<change_name>
node bench/run.js --cells=200  --ticks=5000  --warmup=1000 > bench/results/<change_name>/pop200.txt
node bench/run.js --cells=500  --ticks=5000  --warmup=1000 > bench/results/<change_name>/pop500.txt
node bench/run.js --cells=2000 --ticks=5000  --warmup=1000 > bench/results/<change_name>/pop2000.txt
node bench/run.js --cells=40   --ticks=50000 --warmup=1000 \
  --seed-genome="fa 58 68 c0 7f 3d 00 3d 13 3d 00 3d 12 3d 3d 00 3d 13 3d 00 3d 12 c3 3d 00 3d 13 3d 00 3d 16" \
  > bench/results/<change_name>/seeded.txt
```

Baseline results for comparison live in `bench/results/before_pop200.txt`, `before_pop500.txt`, `before_pop2000.txt`, `before_seeded.txt`. pop200/500/2000 are 5k ticks, seeded is 50k ticks (pop-growth reproducer — longer run exercises the growth curve). Replace `<change_name>` with a short slug describing the change under test (e.g. `sibling_dedup/`).

Flags: `--cells=N`, `--ticks=N`, `--warmup=N`, `--seed=N`, `--seed-genome="<hex bytes>"`, `--quiet`. Injection overwrites the starter cells' chromosomes after `initWorld`.

Caveat: instrumentation wraps ~20 phase functions, which adds ~200 ns per call — the scaling story is trustworthy but absolute per-call numbers on cheap functions (e.g. `motorTick` at <1 µs/call) are dominated by wrapper overhead. Strip the wrapping for precise per-function timing.

### For Agents

**When analyzing evo_net performance, or making any change to the tick path, run the benchmark before and after and report both numbers.** The per-phase breakdown matters more than wall time — a change that shifts time between phases is still worth knowing. Always run the full canonical sweep above (pop200/500/2000 at 5k ticks, seeded at 50k ticks, 1k warmup throughout) and drop results into `bench/results/<change_name>/`; compare against `bench/results/latest_*.txt`. Numbers without scaling context don't prove much, because the top phases shift with population. The seeded reproducer is a pop-growth run — 50k ticks covers the full early-growth curve through steady state. Commit the results directory with the change.

## License

Copyright &copy; 2026 Matas Minelga.

Evonet Worlds is free software, licensed under the **GNU Affero General Public License, version 3 or later** (AGPL-3.0-or-later). See [`LICENSE`](LICENSE) for the full text, or <https://www.gnu.org/licenses/agpl-3.0.html>.

The AGPL is a strong copyleft license. In short:

- You may use, study, modify, and distribute the code freely.
- If you distribute it (modified or not), recipients must get the same freedoms and access to the corresponding source.
- **If you run a modified version as a network service** (web app, multiplayer host, hosted simulator, etc.), you must offer users of that service the source for your modified version. The in-app "Source" link in the panel UI satisfies §13 for the upstream build; downstream forks must keep an equivalent prominent notice pointing at *their* source.

There is **no warranty**, to the extent permitted by law.
