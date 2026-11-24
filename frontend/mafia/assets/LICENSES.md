# Asset licences

Every file in this folder is released under
[CC0 1.0](https://creativecommons.org/publicdomain/zero/1.0/) (public domain). No attribution
is required; the credits below are given anyway. Only the files that `scene.js` loads are kept.

| Folder | Pack | Author | Source | Licence |
|---|---|---|---|---|
| `village/` | KayKit Medieval Hexagon Pack 1.0 | Kay Lousberg (kaylousberg.com) | https://github.com/KayKit-Game-Assets/KayKit-Medieval-Hexagon-Pack-1.0 (commit `84fa4e9`) | CC0 1.0 |
| `graveyard/` | KayKit Halloween Bits 1.0 | Kay Lousberg (kaylousberg.com) | https://github.com/KayKit-Game-Assets/KayKit-Halloween-Bits-1.0 (commit `6dc69bf`) | CC0 1.0 |
| `characters/` | KayKit Adventurers Character Pack 1.0 | Kay Lousberg (kaylousberg.com) | https://github.com/KayKit-Game-Assets/KayKit-Character-Pack-Adventures-1.0 (commit `672074b`) | CC0 1.0 |
| `robot/` | RobotExpressive | Tomás Laulhé (Quaternius), modified by Don McCurdy | https://github.com/mrdoob/three.js/tree/r170/examples/models/gltf/RobotExpressive | CC0 1.0 |

The licence was checked in each source on 2026-11-15:

- Each KayKit repository ships a `LICENSE.txt` that reads "License: (Creative Commons Zero, CC0)
  http://creativecommons.org/publicdomain/zero/1.0/ This content is free to use in personal,
  educational and commercial projects."
- The three.js `README.md` next to `RobotExpressive.glb` reads "Model by Tomás Laulhé. [...] CC0 1.0."

## Files

**`village/`** (each model is a `.gltf` plus a `.bin`; all share the atlas `hexagons_medieval.png`),
copied unchanged from `Assets/gltf/` of the pack:

- buildings: `building_home_A_blue`, `building_home_B_blue`, `building_tavern_blue`,
  `building_church_blue`, `building_windmill_blue`, `building_blacksmith_blue`,
  `building_market_blue`, `building_well_blue`, `building_grain`, `fence_wood_straight`
- nature: `tree_single_A`, `tree_single_B`, `trees_A_medium`, `trees_B_medium`, `trees_B_large`,
  `rock_single_B`, `rock_single_D`, `rock_single_E`, `cloud_big`, `cloud_small`
- props: `barrel`, `crate_A_big`, `crate_B_small`, `sack`, `bucket_water`, `wheelbarrow`,
  `resource_lumber`

**`graveyard/`** (`.gltf` plus `.bin`; all share the atlas `halloweenbits_texture.png`), copied
unchanged from `Assets/gltf/` of the pack: `grave_A`, `grave_B`, `gravestone`, `gravemarker_A`,
`gravemarker_B`, `fence`, `fence_pillar`, `arch`, `post_lantern`, `lantern_standing`,
`tree_dead_large`, `tree_dead_medium`, `bench`.

**`characters/`**: `Knight.glb`, `Barbarian.glb`, `Mage.glb`, `Rogue.glb`, `Rogue_Hooded.glb`,
from `Characters/gltf/` of the pack. These five files were **modified** to cut each from about
3.6 MB to about 0.6 MB:

- only 7 of the 76 animation clips are kept: `Idle`, `Walking_A`, `Interact`, `Cheer`, `Death_A`,
  `Sit_Floor_Down`, `Sit_Floor_Idle`
- the meshes attached to the hand slots (weapons, shields, spell book, mug) are removed
- the binary chunk is repacked without the data that is no longer referenced

Meshes, skeleton, the kept clips and the embedded texture are otherwise untouched.

**`robot/`**: `RobotExpressive.glb`, copied unchanged from the three.js repository at tag `r170`.

## Changes made at run time

The scene recolours things in the browser, without changing these files: roof swatches of the
houses and clothing swatches of the villagers are repainted in each player's colour, and the
robot's body material is tinted. Ground, campfire, hills, name signs and all effects are drawn
by code.
