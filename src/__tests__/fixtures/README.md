# Testbestanden

`lines-v2.rm` — een echt reMarkable `.lines` v6-bestand, overgenomen uit de
testdata van [rmscene](https://github.com/ricklupton/rmscene) (MIT-licentie,
© 2023 Rick Lupton). Opgenomen als regressie-ijkpunt: het formaat is niet
officieel gedocumenteerd, dus een parser die alleen tegen zelfgemaakte data
test, bewijst hooguit dat hij consistent is met de eigen aannames.

Getypte tekst (RootText-blok), ook uit de testdata van rmscene (MIT-licentie,
© 2023 Rick Lupton), hernoemd:

- `text-bold-heading-bullet.rm` ← `Bold_Heading_Bullet_Normal.rm`: alinea-stijlen,
  gewiste tekens en runs die midden in andere runs zijn ingevoegd;
- `text-inline-formats.rm` ← `Normal_A_stroke_2_layers_v3.3.2.rm`: inline vet en
  cursief (firmware 3.3) en inkt verankerd aan tekens in drie alinea's;
- `text-crdt-ordering.rm` ← `test-crdt-ordering.rm`: gelijktijdige invoegingen van
  twee auteurs op dezelfde plek;
- `text-deleted-chars.rm` ← `With_SceneInfo_Block.rm`: gewiste tekens en inkt
  verankerd aan de begin-van-tekst-marker.

`rmscene-text.json` is wat rmscene 0.8.0 (`TextDocument.from_scene_item`) en
rmc (commit da87813, `build_anchor_pos`) uit die vier bestanden halen: alinea's,
stijlen, opmaak, teken-id's en de geschatte y van verankerde inkt.
