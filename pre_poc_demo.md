# Evo Sim — Design Document

**Status:** Draft, pre-PoC
**Version:** 0.3
**Last updated:** 2026-04-20

---

## 1. Project goal

Build a GPU-accelerated artificial life simulator in which simple replicators can emerge from a protein/cell soup. The defining commitment is that cell behavior is determined by the protein population the cell currently holds, not by a discrete "this cell is a sensor" function switch. Evolution acts on genome assembly code, protein composition, slot placement, and regulatory feedback — yielding a smooth fitness gradient.

Success condition: Steam release and open source project that is fun to run, produces evolution and cool new unprogrammed behaviours, can easily link multiple PCs over network or PCIe for multiple GPUs whatever. Full Ecosystem simulated by many players running their own little worlds.

Technical condition: a cell lineage reliably produces viable daughters, with heritable variation, such that selection pressure produces observable trait drift over time. Bonus: this arises from random initial conditions rather than hand-authored seeds.
---

## 2. Positioning relative to prior art

- **ALIEN** (chrxh/alien) — particle-network engine with soft-body physics and predefined high-level cell functions (sensors, muscles, weapons, constructors). CUDA-locked, Nvidia-only. Reference for what a mature sim looks like.
- **EvoLife** — closed-source, Vulkan, multi-GPU but GPUs run independently. Cell-function evolution is too discrete: single-step jumps between functions skip plausible intermediates. Tends to evolve huge protein stacks. Proves Vulkan-on-AMD is a viable path.
- **Bibites** — gamified, flat float-vector genome, no structural evolvability. Plateaus precisely because of this. Not a reference target; a cautionary data point.

**This project's niche:** one abstraction level below ALIEN/EvoLife. Proteins are the functional unit below "cell parts." A cell's behavior emerges from which proteins it has expressed and where they sit.

---

## 3. Cell model

### 3.1 State

Every cell holds:

- **Position, velocity, radius, orientation** — FP32, 2D off-lattice
- **Cytoplasm protein pool** — counts per protein species, non-spatial. Proteins produced by the ribosome land here first, then migrate to slots stochastically.
- **7 slots** — 1 membrane slot + 6 special (directional) slots. Each slot has **10 subslots**, each subslot holds up to **10 proteins of the same type**. See §3.2.
- **Genome** — one or more chromosomes (byte strings). See §4.
- **Ribosome(s)** — per-cell reader state (current chromosome index, byte offset, mode flags). At least one ribosome; mutations can in principle spawn more.
- **Registers** — small number of scalar integer/float slots for counters, thresholds, arithmetic
- **Metadata** — energy level, age, parent ID for lineage tracking, flags

### 3.2 Slot and subslot model

**7 slots per cell:**
- **Slot 0 — Membrane:** wraps the entire cell. Proteins here affect the cell's perimeter uniformly.
- **Slots 1–6 — Special (directional):** positioned at 60° intervals around the cell. Interactions fire only when the slot angle faces the relevant target (neighbor cell, light source, etc.).

**10 subslots per slot:** each subslot holds up to **10 proteins, all of the same type**. A subslot either holds copies of one protein species or is empty.

**Subslot filling — asymmetric left/right interactions:**
Proteins have a **left side** and a **right side**, with different interaction affinities. When a protein binds to a subslot, it is influenced by the protein types in the adjacent subslots:
- The protein in subslot N interacts with subslot N-1 via its **left** side
- The protein in subslot N interacts with subslot N+1 via its **right** side
- Left and right interaction values are **different** — protein X may attract protein Z on its right side but repel it on its left

The interaction table (§4.2) is therefore **64×64×2** — one value for left-affinity, one for right-affinity, for each protein pair.

**Binding dynamics:** cytoplasm proteins migrate to open subslots stochastically. Affinity to a subslot is determined by the left/right interaction with its neighbors. If only subslot 4 is filled, proteins are attracted to subslots 3 (right-side affinity of the candidate toward subslot 4's occupant) and 5 (left-side affinity). The genome can gate which slots are open.

### 3.3 Protein placement semantics

Proteins are always produced into the **cytoplasm** first. From there they migrate to subslots probabilistically, driven by interaction affinities. The genome/ribosome can gate which slots are open at any moment.

Behavior depends on location. The same protein species in the membrane slot, a special slot, or internally does different things.

### 3.3 Scale

Proteins are ~1/100 the linear size of an average cell. This matters for the engulfment case (§3.5): an engulfed cell still has room to run its own protein dynamics inside its parent.

### 3.4 Cell operations

- **Division** — multi-step: elongation phase, then split. Triggered by the cell's own genome/register state crossing thresholds. Proteins and chromosomes partition roughly evenly between daughters. Not a single-tick atomic operation — this is deliberate, it makes GPU scheduling easier and matches biology.
- **Conjugation** — two cells connected via matching special slots can open a bidirectional channel (mutual consent required: both sides must have compatible proteins active). Transfers energy units, proteins, or chromosomes.
- **Engulfment** — a sufficiently larger cell can absorb a smaller one. Absorbed cell continues to function inside the parent, proteins still simulated. Path toward endosymbiosis. Deferrable to post-PoC.
- **Free-floating genetic material** — chromosome fragments in the medium, optionally uptaken by cells.

### 3.5 Connections

Three variants:

- **Cell-to-cell** — via special slots holding connection-type proteins. Both sides must open. Directional (pilus angle matters).
- **Cell-to-object** — cell attached to a free protein or non-cell entity
- **Third variant** — TBD, placeholder

---

## 4. Genome model

### 4.1 Proteins are atomic

A protein has **no internal structure**. It is identified by a single type ID drawn from a fixed set of **64 protein types** (6 bits of information). There is no per-protein shape, no internal parameters, no evolvable sub-structure.

Behavior differentiation is a property of **cells**, not proteins. Two cells differ because their slots hold different *combinations* of the same atomic protein types. A slot with `{type12: 3, type7: 4}` behaves differently from one with `{type12: 7, type7: 4}` because the slot's aggregate function depends on its full composition.

### 4.2 Protein interaction table — world-seeded simulation parameter

How any two protein types interact is defined by a **64 × 64 × 2 interaction table**, generated procedurally at world creation from the world's random seed. Within a single world, the table is fixed. Different worlds (= different seeds) have different chemistries.

The two values per pair are **left-affinity** and **right-affinity** — encoding the asymmetric directional interaction between adjacent subslots. `interactionTable[A][B].left` = affinity when B is to the left of A; `interactionTable[A][B].right` = affinity when B is to the right of A.

Each entry encodes attraction/repulsion for binding. The table is small (~16 KB) and lives in GPU constant memory or a small SSBO.

This gives the project two useful properties:
- **Reproducibility per world.** Same seed → same chemistry → comparable runs.
- **Chemistry diversity across experiments.** Different seeds explore different "universes" without code changes, which is useful when testing whether replicator emergence depends on a specific chemistry or is a more general property.

Protein behavior per type is hardcoded (GPU-friendly dispatch via type ID). The numeric effect of any two types meeting comes from the interaction table.

### 4.3 Chromosome format

Each chromosome is a `uint8[]`. Cells can hold multiple chromosomes.

### 4.4 Codon / opcode encoding

1 byte = 1 opcode. 256 possible opcode values. The ribosome always advances **1 byte per step**.

**Hold-state mechanism:** opcodes that require a parameter do not encode it in the same byte. Instead, the ribosome enters a "holding" state after reading such an opcode. On the next step it reads the following byte as the argument (full 8-bit value). If the argument value exceeds the valid range for that opcode, it wraps (mod N).

The ribosome is not aware of its own position — if it is jumped or relocated while holding, it **remains in hold state**. Whatever byte it lands on is consumed as the argument for the previously held opcode. This is intentional: the ribosome is a simple state machine that doesn't distinguish "normal advance" from "was relocated." Occasional random jumps (frequency set as a world parameter) create noise that interacts with hold state naturally.

This decouples opcode identity from argument value, giving each independent mutation characteristics.

Draft opcode ranges (final allocation TBD during PoC):

| Range | Meaning | Arg? |
|-------|---------|------|
| 0x00–0x1F | Structural / control (NOP, STOP, DIVIDE_MARKER, search anchors) | No |
| 0x20–0x3F | `make_protein` — hold → next byte = protein type (mod 64) | Yes |
| 0x40–0x5F | Slot control (open/close slot, target slot) — hold → next byte = slot index | Yes |
| 0x60–0x7F | Register ops (arithmetic, load immediate) — hold → next byte = immediate value | Yes |
| 0x80–0x9F | Conditional jumps — hold → next byte = threshold/offset | Yes |
| 0xA0–0xBF | Search-jumps (`jmp_find_after`) — hold → next byte = pattern byte to find | Yes |
| 0xC0–0xDF | Chromosome-shape jump (`jmp_shape`) — hold → next byte = shape tag | Yes |
| 0xE0–0xFF | Reserved / NOP-equivalent (mutation soft landing zone) | No |

Multiple opcodes within each range map to the same function (e.g. 0x20 through 0x3F all mean `make_protein`). This gives the genome mutation-softness: most point mutations change behavior slightly or not at all. NOP-equivalents are also scattered across ranges for additional softness.

**Each protein is produced by a single `make_protein` opcode + 1 argument byte — not a multi-opcode block.** There is no START_PROTEIN / END_PROTEIN; proteins are atomic.

### 4.5 Ribosome execution

- **One ribosome per cell minimum.** Multiple ribosomes are possible in principle (if a mutation creates one) but not a design emphasis.
- **Continuous execution.** The ribosome keeps walking the chromosome throughout the cell's life, wrapping at end. Not single-pass at birth.
- **Step rate:** one instruction per ~10 ticks. Controllable at runtime by protein action or register value.
- **Search/scan mode:** `jmp_find_after` scans **1 byte per tick** (much cheaper than executing an instruction). Scans forward up to ~1000 ticks. If the current chromosome ends, the search continues onto another chromosome. On timeout, the ribosome randomly picks a chromosome and resets to its start. This spreads search cost over time rather than spiking a single tick.
- **Multi-chromosome reading:** with multiple chromosomes present, the ribosome may randomly switch to another chromosome at the same byte index at any instruction. Gives cross-chromosome gene mixing at execution time, without an explicit recombination operator.
- **Chromosome shape tags:** each chromosome gets one of ~10 discrete shape tags, computed deterministically from its first ~25 bytes (hash/checksum). `jmp_shape N` jumps to any chromosome in the cell with that shape tag; ties resolve randomly.
- **Energy cost:** `make_protein` costs energy. Without this, cells pump proteins infinitely and the energy economy collapses.
- **Protein degradation:** proteins decay over time at a per-type rate drawn from the world seed. Prevents unbounded accumulation.

### 4.6 Mutation operators

- **Point mutation** — flip a byte with some probability per byte copied
- **Insertion / deletion** — add or remove a byte; shifts all downstream bytes, usually destructive but occasionally creative
- **Duplication** — copy a range within a chromosome; this is how new functional regions are born in real biology
- **Inversion** — reverse a range
- **Chromosome-level:** duplicate entire chromosome, loss of chromosome, recombination between chromosomes in the same cell

---

## 5. Environment

- **Spatially varying ambient energy field** ("light") driving the system out of equilibrium
- **Free proteins and loose molecules** in the medium between cells, simulated as particles
- **Free-floating chromosome fragments** in the medium, uptakeable by cells

---

## 6. Compute architecture

### 6.1 Platform

**Vulkan compute** — cross-vendor portability, mature on AMD, proven by EvoLife. Native subgroup sizes differ between RDNA3 (32) and CDNA1 (64); kernels must handle both via subgroup extensions. Shader language: slang preferred, GLSL acceptable fallback.

### 6.2 Layout

- **SoA (Structure of Arrays)** throughout. Separate arrays per attribute: positions, velocities, slot-composition, internal counts, ribosome state, etc. Each kernel touches only the arrays it needs. Non-negotiable on GPU.
- **Uniform 2D spatial grid**, 2–4 cells per bin average, rebuilt each tick. Cheap neighbor queries.
- **Pre-allocated slab pools** for cells and chromosomes. Free lists. No runtime allocation inside the sim loop.
- **2D off-lattice positions**, FP32, no determinism requirement

### 6.3 Per-tick kernel dispatch order

1. Spatial grid rebuild
2. Ribosome step (for cells due for a codon this tick)
3. Protein kernels — internal effects (metabolism, regulation, decay)
4. Membrane / special-slot interactions between neighbor cells
5. Free-protein physics + reactions
6. Cell physics (integration, collision resolution)
7. Division / death / engulfment bookkeeping

Five-ish separate kernel dispatches per tick. Don't try to fuse — keeps each kernel simple and coalesced.

### 6.4 Memory per cell

Approximate:

| Component | Bytes |
|-----------|-------|
| Position/velocity/radius/orientation | 24 |
| 7 slots × 10 subslots × 1 byte type ID + 1 byte count | 140 |
| 7 slots × open/closed flags | 7 |
| Cytoplasm protein counts (64 types × 2 bytes) | 128 |
| Registers | 32 |
| Ribosome state | 16 |
| Chromosomes (variable, pool-allocated, amortized) | ~512–1024 |
| Metadata | 32 |
| Spatial linkage | 16 |
| **Total per cell** | **~0.9 KB** |
| **Double-buffered** | **~1.8 KB** |

Plus pool-allocated genome and free-protein buffers: effective ~2.5 KB per cell in working memory.

Worlds also carry a **64 × 64 × 2 protein interaction table** (§4.2) — ~16 KB of constant data, shared across all cells in that world.

### 6.5 Multi-GPU

**Spatial portals with 10 MB/s cap per link.** At ~3 KB per cell in wire format this allows ~3,000 cell-migrations per second across a portal — fine for an emigration-only boundary model, not viable for shared neighborhood computation.

**Explicit design consequence:** the multi-GPU setup runs nearly-independent worlds connected by rare migration, not one coherent shared world. This maps cleanly onto allopatric speciation and is much simpler to engineer than tight multi-GPU coupling. Embrace it.

**Topology when adding 2× MI50 32GB:** three nearly-independent regions, each on its own card. No cross-region per-tick dependencies.

---

## 7. Performance targets and budget

### 7.1 Targets

| Scenario | Cell count | Tick rate |
|---------|-----------|-----------|
| Baseline | 10,000 | 100 ticks/sec |
| Graceful degradation | 100,000 | 10 ticks/sec |
| Estimated single-GPU ceiling (7900 XTX) | ~100,000 | 100 ticks/sec |
| VRAM capacity (not compute-limited) | ~2–3 million | — |

Interactive rendering is **not required** at sim tick rate. Headless-first; rendering is a separate consumer of periodic snapshots.

### 7.2 Bottleneck analysis

Compute budget at 100 ticks/sec on a 7900 XTX (~61 TFLOPS FP32, ~960 GB/s bandwidth) is ~610 GFLOPs and ~9.6 GB memory traffic per tick. Our workload at 100k cells uses a small fraction of this.

**Real bottlenecks:**
- Kernel divergence (cells in different ribosome states executing different opcodes)
- Memory access patterns on the 4–5 KB cell struct (bigger than L1 cache line)
- Grid rebuild quality (avoiding atomic contention on bin counters)

**Mitigations:**
- Sort/bucket cells by ribosome opcode before dispatch
- SoA layout, kernels touch minimal attribute sets
- Alternative grid algorithms (prefix-sum-based binning) if atomics hurt

### 7.3 Search-jump cost (clarified)

Search-jumps scan 1 byte per tick for up to 1000 ticks. A cell in search mode consumes ~1 byte of chromosome memory per tick — trivial. The cost is spread across the search duration rather than spiked, which is better for tick-rate stability than a burst scan.

---

## 8. PoC plan — Browser JavaScript

### 8.1 Purpose

Validate the logical model before committing to GPU implementation. Discovering at GPU stage that genome execution deadlocks, slot composition can't produce interesting behavior, or energy flow is broken would waste months.

### 8.2 Scope

Single HTML file, vanilla JS + Canvas2D, no build step. 100 cells at 1 tick/sec is fine — this is not a performance artifact.

### 8.3 What the PoC must answer

1. Does the opcode/ribosome genome execution actually work on realistic random initial chromosomes? Does it degenerate into stuck ribosomes, infinite search loops?
2. Does slot composition with 64 atomic protein types + a seeded interaction table produce enough behavioral variation to distinguish "similar but different" cells?
3. **Can a hand-designed replicator actually work in this model?** Before asking evolution to find one, confirm one can exist. This is the critical milestone.
4. Does energy flow sensibly? Is the balance tunable via the interaction table + decay rates?
5. What does a reasonable set of 64 protein types + interaction table actually look like, once forced to instantiate them?
6. Under mutation, does a hand-authored replicator's lineage survive? Drift? If tiny mutations always kill, selection has nothing to work with.
7. Is the interaction-table-as-world-seed approach useful in practice, or do most seeds produce uninteresting chemistries?

### 8.4 What the PoC will NOT do

- Performance (JS, Canvas2D, tiny worlds)
- Rendering polish
- Soft-body physics
- Multi-GPU, portals, anything Vulkan-related
- All 64 protein types at once — start with ~8–12 covering core roles (photon catcher, energy sink, membrane modifier, connection-maker, divider trigger, etc.)

### 8.5 Module layout (single-file but mentally separated)

- **World** — cells, free proteins, energy field, tick counter, RNG-seeded interaction table
- **Cell** — SoA internally even in JS (practice for GPU layout, catches design issues early)
- **Genome** — chromosomes as `Uint8Array`, opcode decoder, ribosome struct
- **Opcode table** — object mapping opcode byte → handler function
- **Protein behaviors** — one handler per protein type, reads the world's interaction table for pairwise effects
- **Physics** — position integration, circle collision, small spatial grid
- **Scheduler** — one tick: grid → ribosome → protein effects → interactions → physics → division/death
- **UI** — pause/step/play, speed slider, click-to-inspect, stats panel
- **Telemetry** — population, energy, top lineages, genome length distribution, interaction-table heatmap viewer

### 8.6 Milestones

**M1 — World skeleton + rendering.** Canvas draws cells. Click-to-inspect. No biology yet.

**M2 — Opcode decoder + ribosome.** Execute hand-written chromosomes. `make_protein`, NOPs, arithmetic, conditional jumps, search-jumps with 1-byte/tick scan. Verify correctness on a hand-authored test program.

**M3 — Slots + protein synthesis.** Ribosome produces proteins from `make_protein X` opcodes, places them in slots via slot-control opcodes. Implement ~4 protein types: photon catcher, energy sink, "strengthen next" slot modifier, connection-maker.

**M4 — Energy flow + interaction table.** Seeded 64×64 interaction table (only relevant subset used at this stage). Ambient energy field, photon catchers produce, metabolism consumes. Cells die when depleted. Verify a hand-built plant-like cell survives under a light source.

**M5 — Division. CRITICAL.** Multi-tick elongation then split. Chromosome and protein partition. Verify a hand-built replicator produces viable children that themselves divide. If M5 doesn't work, the model is wrong and must be redesigned before GPU.

**M6 — Mutation + lineage tracking.** Copy errors per chromosome copy, mutation operators from §4.6, parent-ID tracking, simple lineage visualization. Run hand-authored replicator with mutation on. Observe drift over 10k ticks.

**M7 — Cell-cell interactions.** Remaining protein types. Special-slot alignment for directional interactions. Conjugation.

**M8 — Scale test.** Push JS to 500–1000 cells, measure tick rate, identify dominant operations. Gives real numbers for GPU budgets — supersedes the estimates in §7.

**M9 — Random seed soup.** Initialize with random chromosomes and random interaction tables, no hand-authored replicators. Observe. If nothing replicates, characterize the failure (what's the closest to replication that appears? What's missing? Are there interaction-table seeds that do better than others?).

### 8.7 Deliverable

- Single HTML file runnable offline
- Documented opcode table and 64-protein-type list (matches what GPU version will implement)
- At least one hand-designed replicator chromosome that demonstrably works
- Written notes on what needed redesign, what the GPU version must change, what M9 revealed about emergence from random conditions

---

## 9. Open questions

These need to be resolved during or after the PoC. Flagged for tracking.

1. **Opcode table design.** §4.4 is a schematic only. The actual 256-entry table with its redundancy pattern is TBD. Determines the mutation landscape.
2. **Interaction table generation.** §4.2 says "procedurally seeded" but the generator itself is unspecified. Uniform random? Structured (clusters of similar proteins)? Biased toward some baseline chemistry? Tune during M4–M9.
3. **Protein type semantics.** 64 types means 64 hardcoded behaviors. The full list is TBD; start with ~12 core types in PoC and grow the set based on what the model needs.
4. **Third connection variant.** §3.5. Placeholder.
5. **Ribosome multiplicity.** Should mutations be allowed to spawn additional ribosomes, or is one per cell hardcoded? Opens developmental complexity at the cost of stability.
6. **Single-pass fallback mode.** A debug flag that runs the ribosome single-pass-at-birth. Low cost, high debug value for isolating "is the genome wrong or are the dynamics unstable?" Not required but recommended.
---

## 10. Glossary

- **Cell** — top-level spatial entity, holds proteins and genome
- **Protein** — atomic functional unit. Identified by a single type ID (0–63). No internal structure. Can be internal (counts only) or membrane/special-slot (spatially simulated).
- **Protein type** — one of 64 fixed species. Behavior is hardcoded per type; pairwise effects read from the world's interaction table.
- **Interaction table** — 64×64 table of pairwise protein effects, seeded at world creation. Fixed per-world simulation parameter.
- **Slot** — one of 7 positions on a cell: 1 membrane (wraps entire perimeter) + 6 special (directional, at 60° intervals). Each slot has 10 subslots.
- **Subslot** — one of 10 positions within a slot. Holds up to 10 proteins of the same type. Filling driven by asymmetric left/right interaction affinities between neighboring subslots.
- **Chromosome** — byte string of opcodes; a cell may hold several.
- **Opcode** — 1 byte of chromosome (256 possible values). Opcodes needing a parameter use the ribosome's hold-state mechanism to consume the next byte as an argument.
- **Ribosome** — per-cell reader head walking a chromosome.
- **Portal** — bandwidth-capped boundary between worlds on different GPUs.
- **Replicator** — cell lineage producing viable daughters with heritable variation.

---

## 11. Revision notes

- v0.1 — initial consolidation of Vulkan/architecture chat spec
- v0.2 — incorporated other-chat's codon/ribosome framing; incorrectly pulled in shape-space and multi-codon proteins that were never confirmed
- v0.3 — corrected: proteins are atomic (single type ID, no internal structure), protein-pair interaction is a 64×64 world-seeded table, each protein produced by a single opcode, §4 rewritten accordingly, downstream memory/portal math updated
- v0.4 — slot model redesigned: 7 slots (1 membrane + 6 special) × 10 subslots × 10 proteins max per subslot (same type only). Asymmetric left/right protein interactions drive subslot filling. Interaction table is now 64×64×2 (left + right affinity). Memory table updated.