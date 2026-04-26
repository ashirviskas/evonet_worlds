### Some of my ramblings as a basis for next features

Proteins have 4 "sides". When building complexes we attach proteins at both "ends", front and back depending on the order (and attraction forces if in cytoplasm). left and right is used for binding to other free floating or proteins in slots. Though this idea needs further work.

Each protein "side" has different attractions or for each other protein "side", set by the world seed. Basically a look-up table. Hopefully cached. Hopefully amount of proteins can also be limited to small amounts to have reasonable sized look-up tables for performance.

Protein to dismantle/digest chromosomes. Dismantled chromosomes give replicase. OR actual building blocks when we move onto protein-made chromosomes.

Protein enzyme to digest each protein - when touched or combined, releases 80% (or whatever) of energy that was required for creating both. Or if long lived enzyme - only the target is consumed with small % chance to destroy enzyme.

To keep things optimized, we can't do everything purely on attractions and proteins, so cells may actually require state...

Cells can have other cells living inside of them. Either as food or as a nucleus or whatever else may be their function. Released on membrane burst, distributed equally if possible when parent cell divides.

Big cells can absorb smaller cells if membrane allows. Then we start simulating big cell insides as a mini-world. Different environment than free world (slower degrading proteins for example) by default and further modified depending on inner membrane.

Cell size - TBD. Maybe grown by P:GROW_MEMBRANE proteins. Incrases required membrane upkeep by % it is grown.

Membrane should have inner and outer slots.

Multiple ribosomes!

A way for cell to somehow "know" the state of current chromosome counts and maybe even inner cells before dividing so it doesn't produce empty offspring. Main questions - will protein-only be enough? Or do we need different messaging methods? Like "pressure" inside cell that can be felt by various proteins/complexes and jump on/off the chromosome to block or allow reading certain sections.

A way for division to not be immediate, but actually simulate enlongation inside cell and let it happen over multiple ticks. But also not a complex procedure to allow happen naturally.

Chromosome should allow binding. 256 proteins to bind on specific bytes. When binded = instruction skipped.

Or actually, even better:
Proteins can be made up of different parts. Ribosome starts making protein till finding stop making protein

In chromosome:
1 byte - general type (original types + binder (binds to chromosome/other proteins. To block ribosome reading or make it skip or disable another protein behaviour. Or maybe prevent protein from being eaten) + enzyme)  
2 byte - data/modifier (could be protein type or dna byte to bind to)
3 byte - general type (same as 1st byte) or extend modifier. If general type, it means this protein is made up of two proteins. So maybe if first one was bind, this one could be enzyme. So if this was made up of (adding next protein examples too) [BIND_PROTEIN:AA]|[ENZYME:<..we are here in protein structure, other proteins are next..>BB type]|[BIND:CC[blocker_type]]|[ADDITIONAL_BIND_RULE_DATA:[A1 data]]. So, what it would do: it would randomly bind to a protein that has [AA:any data]|[BB:any data]|[CC:A1 data] and would enzyme the BB.
4 byte - data/modifier. If previous was extend modifier and type was binder, this would allow to make binder that binds matches to multiple bytes in row (like match this byte, match this or something)
5 byte - general|extend
6 byte - data/modifier. Maybe third byte/protein to match when binding
7 byte - general | extend
8 byte - data/modifier. Maybe fourth byte/protein to match when binding

Protein maker machine either auto stops after 8 bytes OR encounters STOP_MAKING_PROTEIN. Could be reserved byte in protein types. So 127 proteins. Lets actually make a few more reserved things like this.

Actually. Maybe we don't need to enforce this structure. maybe just first bit should be enough. That still gives us 128(- reserved) protein types and 128 data targets.

Then we would also have slot_opener 0-6 to open slot
slot closer 0-6 to close slot

Dna could make some of them to open slot, then make something to put into the slot, then make enzymes to clear out slot openers, then make slot closers if wants to close the slots

protein enzymes could also be long_lived or short_lived

most proteins should live longer than current time (unrealistic for cell to need to remake each protein in 10k steps as they may be disintegrated... Should live at least half life of a cell life, which can be up to 1M I guess.)

Add energy storage proteins. They can be in two states - with energy (causes more energy to make, but can be later consumed for energy) or without energy (can bind to free floating ATP)

Yeah, lets replace current cell energy with ATP inside it. It would be consumed to make shit.

And we don't need hardcoded slots tbh! MEMBRANE_ATTACH_PROTEIN|SLOT_OPENER_PROTEIN|[OPTIONAL_SLOT_FORM_PROTEIN - to allow define this slot as some form for later distinguishing. Could be any other protein tbh, we don't need specific type here. ]__MEMBRANE_ATTACH_PROTEIN could "force" these inside the cell. But still, we can hardcode the 6 slot limit

Then we could make MEMBRANE_ATTACH_PROTEIN|PUSHER_PROTEIN:TARGET(s)_TO_PUSH (or maybe TARGET(s)_TO_BLOCK depending on type)|optional other pushers|ATTACH_TO_PROTEIN:SAMETYPE AS ON OUR MEMBRANE|optional membrane protein.

Could be pushers, pullers and more. Allow for filtering in/or out what we take from the outside or another connected cell.


We could then squeeze either our dna to other cells or send them proteins or ATP or whatever. We could block what we don't want etc.


All this needs to be properly evaluated for GPU compute, if it matches what GPUs do well. Need to update possible performance metrics.


We need to introduce other materials for cells to require to build protein, not just out of pure energy lol. So maybe like minerals that could be dissolved.

Allow for a nice primordial soup - allow replicase to bind on free-floating chromosomes, don't degrade them as fast by default. Maybe only when hit by a photon?

Photons can be energy 3x by default (1 light + 2 UV) that is damaging to chromosomes (mutates them or punches bytes out, punches in half) and most protein (also modifies them somehow or destroys, have different chances). But can then filtered by membranes if they have certain proteins to lower energy state (to non uv light) that would NOT harm the chromosomes inside and allow for inner cells to do photosynthesis. Or inner free-floating proteins. Or do something else, like a catalyst for some reactions. Another type of energy.

If UV hits inner membrane, deals damage to it. Inner/outer is same membrane, just two sides of it.

Proteins to do photosynthesis on UV.

Light if not captured or consumed should "reflect". Photon is 1 byte - 1 bit for base light 1 bit for more powerful UV.

RN we have 64 different proteins in 4 different "flavors". All of them act identical, but could be different variants of the protein that have different attraction values.

Can we keep having only 64 proteins?? How to match 256 possible dna values?